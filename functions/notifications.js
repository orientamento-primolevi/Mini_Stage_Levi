'use strict';
const PDFDocument = require('pdfkit');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { ROOT } = require('./firestore-repository');
const EMAIL_URL = 'https://script.google.com/macros/s/AKfycby3UI3dEPG9OEzOIHmEK7QLIIUMC6b4yopSFm-twGBV6ZLWtVAZTvmfsa7UxKHFOXfqbQ/exec';
function makePdf(b) {
  return new Promise((resolve,reject)=>{
    const pdf = new PDFDocument({ size:'A4',margin:48 });
    const chunks=[]; pdf.on('data',chunk=>chunks.push(chunk)); pdf.on('end',()=>resolve(Buffer.concat(chunks))); pdf.on('error',reject);
    pdf.fontSize(20).text('IIS Primo Levi - MiniStage');
    pdf.moveDown().fontSize(14).text(b.type === 'lista_attesa' ? 'ISCRIZIONE CON RISERVA - NON VALIDA COME PASS' : b.type === 'cancellazione' ? 'PRENOTAZIONE ANNULLATA' : b.type === 'uscito' ? 'ATTESTATO DI PARTECIPAZIONE' : 'CONFERMA PRENOTAZIONE');
    pdf.moveDown().fontSize(10);
    for (const line of [`Codice: ${b.code}`,`Studente: ${b.nome}`,`Scuola: ${b.scuola}`,`Percorso: ${b.indirizzo}`,`Data: ${b.stageDay} ${b.stageDate}`,`Orario: ${b.stageTime}`,`Classe: ${b.classeAssegnata || 'Da definire'}`]) pdf.text(line).moveDown(0.5);
    pdf.moveDown().text('Conserva il codice e usa la stessa email per recuperare o annullare la prenotazione sul sito.');
    if (b.type === 'prenotazione') pdf.moveDown().text('Accoglienza alle 14:15 in Via Briantina 68, Seregno.');
    if (b.exitMode === 'autonoma' && b.type === 'prenotazione') {
      pdf.addPage().fontSize(18).text('Autorizzazione all’uscita autonoma').moveDown();
      pdf.fontSize(11).text(`Il/La sottoscritto/a ${b.parentGuardianName}, in qualità di ${b.parentGuardianRole}, autorizza ${b.nome} a lasciare autonomamente l’IIS Primo Levi al termine del MiniStage del ${b.stageDate} (${b.stageTime}).`).moveDown();
      pdf.text(`Codice prenotazione: ${b.code}`).moveDown();
      pdf.text('Stampare, firmare e consegnare questa pagina insieme a una copia del documento di riconoscimento in corso di validità del genitore/tutore.').moveDown(3);
      pdf.text('Data: ____________________     Firma: __________________________');
    }
    pdf.end();
  });
}
exports.sendBookingNotification = onDocumentCreated({ document:'notification_jobs/{jobId}',region:'europe-west1',retry:true,maxInstances:2 }, async event=>{
  const jobRef=event.data.ref;
  const job=(await jobRef.get()).data();
  if (!job || job.status==='sent' || job.status==='skipped') return;
  const doc=await getFirestore().doc(`${ROOT}/prenotazioni_v2/${job.code}`).get();
  if (!doc.exists) { await jobRef.update({status:'skipped'}); return; }
  const b=doc.data();
  if (job.kind !== 'recovery' && job.kind !== b.type) { await jobRef.update({status:'skipped'}); return; }
  if (b.email.endsWith('.invalid')) { await jobRef.update({status:'skipped',reason:'test-address'}); return; }
  const pdf=await makePdf(b);
  const name=b.nome.split(' ');
  const status=b.type==='lista_attesa'?'ISCRIZIONE CON RISERVA':b.type==='cancellazione'?'PRENOTAZIONE ANNULLATA':b.type==='uscito'?'ATTESTATO DI PARTECIPAZIONE':'PRENOTAZIONE CONFERMATA';
  const payload={ email:b.email,nome:name.shift(),cognome:name.join(' '),codice_prenotazione:b.code,pdfBase64:pdf.toString('base64'),tipo:b.type==='lista_attesa'?'iscrizione_con_riserva':b.type,stato:status,classe_assegnata:b.classeAssegnata || '',subject:`MiniStage IIS Primo Levi - ${status}`,oggetto:`MiniStage IIS Primo Levi - ${status}`,message:`${status}. Codice ${b.code}. Conserva il codice per recupero e annullamento.`,messaggio:`${status}. Codice ${b.code}.` };
  const response=await fetch(EMAIL_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  const body=await response.text();
  if (!response.ok || /^\s*</.test(body) || /"(?:success|ok)"\s*:\s*false|"error"\s*:|exception/i.test(body)) {
    await jobRef.update({status:'failed',lastAttemptAt:Date.now()});
    throw new Error('Email provider did not acknowledge the request');
  }
  // L'accettazione dell'Apps Script non prova la consegna nella casella destinataria.
  await jobRef.update({status:'sent',providerAcceptedAt:Date.now()});
});
exports.makePdf=makePdf;
