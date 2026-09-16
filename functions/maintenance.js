'use strict';
const { onSchedule }=require('firebase-functions/v2/scheduler');
const { getFirestore }=require('firebase-admin/firestore');
const { createRepository }=require('./firestore-repository');
const { ACTIVE }=require('./booking-service');
exports.maintainBookings=onSchedule({schedule:'every 15 minutes',timeZone:'Europe/Rome',region:'europe-west1',maxInstances:1},async()=>{
  const repository=createRepository(getFirestore());
  const slots=await repository.collection('slots').get();
  const now=Date.now();
  const date=new Date(now).toLocaleDateString('en-CA',{timeZone:'Europe/Rome'});
  const time=new Date(now).toLocaleTimeString('it-IT',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit'});
  for(const doc of slots.docs){
    await repository.withSlot(doc.id,async ctx=>{
      const slot=ctx.slot;
      const end=String(slot.time || '').match(/(\d{1,2}:\d{2})\s*$/)?.[1]?.padStart(5,'0');
      const finished=slot.isoDate && (slot.isoDate<date || (slot.isoDate===date && end && time>=end));
      if(finished){
        for(const b of ctx.bookings.filter(b=>b.type==='entrato')) ctx.update({...b,type:'uscito',exitAt:now,autoClosedAt:now});
        return;
      }
      if(slot.active===false)return;
      const free=Math.max(0,slot.postiMax-ctx.bookings.filter(b=>ACTIVE.has(b.type)).length);
      const queue=ctx.bookings.filter(b=>b.type==='lista_attesa').sort((a,b)=>a.timestamp-b.timestamp || a.code.localeCompare(b.code));
      for(const b of queue.slice(0,free))ctx.update({...b,type:'prenotazione',waitlistPromotedAt:now,waitlistPromotionStatus:'Ammesso da scorrimento',iscrizioneConRiserva:false});
    });
  }
});
