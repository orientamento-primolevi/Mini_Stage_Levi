'use strict';
const ROOT = 'artifacts/ClJzJkLPS6LWHAzKjLQe/public/data';
const names = { bookings:'prenotazioni_v2', slots:'impostazioni_stage', caps:'config_capacita', classes:'config_classi_ministage', reminder:'config_promemoria', scanner:'scanner_sessions' };
const addresses = ['Liceo Scientifico - Scienze Applicate','Liceo Scientifico - Opzione Scienze Applicate - Curvatura Economica','Relazioni Internazionali per il Marketing (RIM)','Logistica - Quadriennale','Costruzione Ambiente e Territorio (CAT)','Sistema Moda'];
const classNames = ['1L Liceo Scienze Applicate','','1N RIM','1I Logistica','1D CAT','1A Sistema Moda'];
function createRepository(db) {
  const collection = key => db.collection(`${ROOT}/${names[key] || key}`);
  return {
    db, collection,
    async ensureSeed() {
      const ref = db.doc('backend_metadata/calendar-v1');
      await db.runTransaction(async tx => {
        if ((await tx.get(ref)).exists) return;
        for (const [i, indirizzo] of addresses.entries()) {
          tx.create(collection('caps').doc(indirizzo), { indirizzo, postiMax:25 });
          tx.create(collection('classes').doc(indirizzo), { indirizzo, classe:classNames[i] });
          for (const [j, date] of ['2026-11-06','2026-11-20'].entries()) {
            const id = `MINISTAGE-2026-${date.slice(5).replace('-','')}-${i+1}`;
            tx.create(collection('slots').doc(id), { id, indirizzo, isoDate:date, day:'Venerdì', dateStr:date.slice(8)+'/'+date.slice(5,7)+'/'+date.slice(0,4), time:'14:30 - 16:30', postiMax:25, active:true, sortOrder:j*100+i });
          }
        }
        tx.create(ref, { initializedAt: Date.now() });
      });
    },
    async getBooking(code) { const snap = await collection('bookings').doc(code).get(); return snap.exists ? snap.data() : null; },
    async withSlot(id, callback) {
      return db.runTransaction(async tx => {
        const slotRef = collection('slots').doc(id);
        const slotSnap = await tx.get(slotRef);
        const slot = slotSnap.exists ? slotSnap.data() : null;
        const bookings = await tx.get(collection('bookings').where('slotId','==',id));
        const cl = slot ? await tx.get(collection('classes').doc(slot.indirizzo)) : null;
        const operations = [];
        const result = await callback({ slot, bookings:bookings.docs.map(d=>d.data()), className:cl?.exists ? cl.data().classe : '', create:b=>operations.push(['create',b]), update:b=>operations.push(['set',b]), remove:b=>operations.push(['delete',b]) });
        // Tutte le modifiche a uno slot condividono questa revisione: evita overbooking.
        if (operations.length) {
          tx.update(slotRef, { revision:Number(slot.revision || 0)+1 });
          for (const [method,b] of operations) {
            if (method === 'delete') { tx.delete(collection('bookings').doc(b.code)); continue; }
            tx[method](collection('bookings').doc(b.code), b);
            const old = bookings.docs.find(d=>d.id === b.code)?.data();
            if (!old || (old.type !== b.type && ['prenotazione','cancellazione','uscito'].includes(b.type))) tx.set(db.doc(`notification_jobs/${b.code}-${b.type}`), { code:b.code, kind:b.type, createdAt:Date.now(), status:'pending' });
          }
        }
        return result;
      });
    },
    async state(admin = false) {
      const entries = await Promise.all(Object.entries(names).map(async ([key,name]) => {
        if (!admin && key === 'scanner') return [name,[]];
        const snapshot = await collection(key).get();
        const values = snapshot.docs.map(d=>({ ...d.data(), id:d.id }));
        if (!admin && key === 'bookings') {
          // Compatibilità UI: righe di sola occupazione, senza identificativi o dati personali.
          const safe = values.filter(b=>['prenotazione','entrato','uscito','lista_attesa'].includes(b.type)).map((b,i)=>({id:`occupancy-${i}`,slotId:b.slotId,type:b.type === 'uscito' ? 'entrato' : b.type,timestamp:i}));
          return [name,safe];
        }
        return [name,values];
      }));
      return Object.fromEntries(entries);
    }
  };
}
module.exports = { createRepository, ROOT, names };
