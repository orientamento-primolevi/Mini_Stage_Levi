'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { createHash } = require('node:crypto');
const { createService, ApiError } = require('./booking-service');
const { createRepository, ROOT, names } = require('./firestore-repository');
initializeApp();
const db = getFirestore();
const repository = createRepository(db);
const service = createService(repository);
const adminEmail = 'orientamento@leviseregno.edu.it';
let seeded;
let cached;
const origins = new Set(['https://orientamento-primolevi.github.io','http://localhost:4173','http://127.0.0.1:4173']);
async function isAdmin(req) {
  const bearer = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!bearer) return false;
  try {
    const user = await getAuth().verifyIdToken(bearer[1], true);
    return user.email_verified === true && user.email === adminEmail && user.firebase?.sign_in_provider === 'google.com';
  } catch { return false; }
}
async function rateLimit(req) {
  const key = createHash('sha256').update(req.ip || 'unknown').digest('hex');
  const ref = db.doc(`backend_rate_limits/${key}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const previous = snap.data();
    const current = previous && now - previous.start < 60000 ? previous : { start:now, count:0 };
    if (current.count >= 20) throw new ApiError('RATE_LIMIT', 'Troppe richieste. Riprova tra un minuto.', 429);
    tx.set(ref, { start:current.start, count:current.count+1 });
  });
}
function parsePath(path) {
  if (typeof path !== 'string' || !path.startsWith(ROOT+'/')) throw new ApiError('INVALID_PATH','Percorso non valido');
  const [collection, ...parts] = path.slice(ROOT.length+1).split('/');
  if (!Object.values(names).includes(collection) || parts.length !== 1 || !parts[0]) throw new ApiError('INVALID_PATH','Percorso non valido');
  return { collection, id:parts[0], ref:db.doc(path) };
}
exports.bookingApi = onRequest({ region:'europe-west1', maxInstances:2, memory:'256MiB', timeoutSeconds:30, invoker:'public' }, async (req,res) => {
  res.set('Cache-Control','no-store');
  res.set('Vary','Origin');
  const origin = req.get('Origin');
  if (origin && !origins.has(origin)) return res.status(403).json({ error:'ORIGIN_DENIED',message:'Origine non autorizzata' });
  if (origin) res.set('Access-Control-Allow-Origin',origin);
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error:'METHOD_NOT_ALLOWED' });
  try {
    if (!req.is('application/json') || Buffer.byteLength(JSON.stringify(req.body || {})) > 16384) throw new ApiError('INVALID_INPUT','Richiesta non valida');
    const { action, data = {} } = req.body;
    await (seeded ||= repository.ensureSeed().catch(e=>{seeded=null;throw e;}));
    const admin = await isAdmin(req);
    if (action === 'state') {
      if (admin) return res.json({ collections:await repository.state(true), admin:true });
      if (!cached || cached.until < Date.now()) cached = { until:Date.now()+3000, data:await repository.state(false) };
      return res.json({ collections:cached.data, admin:false });
    }
    if (!admin) await rateLimit(req);
    let result;
    if (action === 'book') result = await service.book(data);
    else if (action === 'lookup') result = await service.lookup(data.code,data.email);
    else if (action === 'cancel') result = await service.cancel(data.code,data.email);
    else if (action === 'scanner-validate' || action === 'scanner-checkin') {
      if (!/^[a-f0-9]{48}$/.test(data.token || '')) throw new ApiError('FORBIDDEN','Sessione scanner non valida',403);
      const hash=createHash('sha256').update(data.token).digest('hex');
      const session=(await repository.collection('scanner').doc(hash).get()).data();
      if (!session?.active || session.expiresAt < Date.now()) throw new ApiError('FORBIDDEN','Sessione scanner scaduta o revocata',403);
      if (action === 'scanner-validate') result={valid:true};
      else {
        if (!/^MS-[A-F0-9]{24}$/.test(data.code || '')) throw new ApiError('INVALID_INPUT','Codice non valido');
        const booking=await repository.getBooking(data.code);
        if (!booking) throw new ApiError('NOT_FOUND','Codice non trovato',404);
        result=await repository.withSlot(booking.slotId,async ctx=>{
          const b=ctx.bookings.find(b=>b.code===booking.code);
          if (b.type!=='prenotazione') throw new ApiError('INVALID_STATE','Prenotazione non attiva o presenza già registrata',409);
          ctx.update({...b,type:'entrato',checkInAt:Date.now(),checkInSource:'smartphone'});
          return {message:`Presenza registrata: ${b.nome}`};
        });
      }
    }
    else if (action === 'recover') {
      if (typeof data.email !== 'string' || data.email.length > 254 || typeof data.nome !== 'string' || data.nome.length > 120) throw new ApiError('INVALID_INPUT','Inserisci nome ed email');
      const matches = await repository.collection('bookings').where('email','==',data.email.trim().toLowerCase()).limit(30).get();
      for (const item of matches.docs) {
        const b=item.data();
        if (b.nome.trim().toLowerCase()===data.nome.trim().toLowerCase() && b.type!=='cancellazione') {
          const key=`${b.code}-recovery-${Math.floor(Date.now()/300000)}`;
          await db.doc(`notification_jobs/${key}`).create({code:b.code,kind:'recovery',status:'pending',createdAt:Date.now()}).catch(e=>{if(e.code!==6)throw e;});
        }
      }
      result={message:'Se i dati corrispondono a una prenotazione, riceverai il codice via email.'};
    }
    else if (action === 'admin-check') { if (!admin) throw new ApiError('FORBIDDEN','Account commissione non autorizzato',403); result = { admin:true }; }
    else if (action === 'admin-write') {
      if (!admin) throw new ApiError('FORBIDDEN','Accesso riservato alla commissione',403);
      const target = parsePath(data.path);
      if (!['set','update','delete'].includes(data.operation)) throw new ApiError('INVALID_INPUT','Operazione non valida');
      if (target.collection === names.bookings) {
        const previous = await repository.getBooking(target.id);
        if (!previous) throw new ApiError('INVALID_INPUT','Per nuove prenotazioni usare il modulo di iscrizione');
        if (data.value?.type === 'cancellazione') result = await service.cancel(previous.code,previous.email);
        else result = await repository.withSlot(previous.slotId, async ctx => {
          const current = ctx.bookings.find(b=>b.code===previous.code);
          if (!current) throw new ApiError('NOT_FOUND','Prenotazione non trovata',404);
          if (data.operation === 'delete') { ctx.remove(current); return {ok:true}; }
          const allowed = new Set(['type','checkInAt','checkInSource','authorizationPaperReceived','authorizationPaperReceivedAt','reminderSent','reminderSentAt','certificateSent','certificateSentAt','certificateMailRequestedAt','classeAssegnata','reservePositionAtRegistration','reserveMailRequestedAt','iscrizioneConRiserva','waitlistStatus']);
          if (Object.keys(data.value || {}).some(k=>!allowed.has(k))) throw new ApiError('INVALID_INPUT','Modifica non consentita');
          if (data.value.type && !(current.type === 'prenotazione' && data.value.type === 'entrato') && !(current.type === 'entrato' && data.value.type === 'uscito')) throw new ApiError('INVALID_STATE','Cambio di stato non consentito',409);
          const updated = { ...current,...data.value }; ctx.update(updated); return updated;
        });
      } else {
        if (data.operation === 'delete') {
          if (target.collection === names.slots) {
            await db.runTransaction(async tx=>{
              await tx.get(target.ref);
              const bookings=await tx.get(repository.collection('bookings').where('slotId','==',target.id).limit(1));
              if(!bookings.empty)throw new ApiError('INVALID_STATE','Disattiva lo slot: contiene prenotazioni',409);
              tx.delete(target.ref);
            });
          } else await target.ref.delete();
        } else {
          if (!data.value || typeof data.value !== 'object' || Array.isArray(data.value)) throw new ApiError('INVALID_INPUT','Dati non validi');
          if (data.value.postiMax !== undefined && (!Number.isInteger(data.value.postiMax) || data.value.postiMax < 1 || data.value.postiMax > 200)) throw new ApiError('INVALID_INPUT','Capienza non valida');
          await target.ref.set(data.value, { merge:data.operation === 'update' || data.merge === true });
        }
        result = { ok:true };
      }
    } else throw new ApiError('INVALID_ACTION','Operazione non disponibile',404);
    cached = null;
    res.json(result);
  } catch(error) {
    // Mai registrare nel log nomi, email, telefoni o corpi delle richieste.
    if (!(error instanceof ApiError)) console.error('bookingApi', error.code || error.name);
    res.status(error.status || 503).json({ error:error.code || 'UNAVAILABLE',message:error instanceof ApiError ? error.message : 'Servizio temporaneamente non disponibile. Riprova.' });
  }
});
exports.sendBookingNotification = require('./notifications').sendBookingNotification;
exports.maintainBookings = require('./maintenance').maintainBookings;
