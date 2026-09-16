const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createService,validateInput}=require('../booking-service');
const form={slotId:'slot-1',nome:'Studente Test',scuola:'Scuola Test',email:'test@example.invalid',cellulare:'3331234567',parentGuardianName:'Genitore Test',parentGuardianRole:'madre',exitMode:'autonoma',declarationAccepted:true,requestId:'00000000-0000-4000-8000-000000000001'};
function setup(capacity=1){
  const records=new Map();
  const slot={indirizzo:'Liceo',day:'Venerdì',dateStr:'06/11/2026',isoDate:'2026-11-06',time:'14:30 - 16:30',postiMax:capacity,active:true};
  let pending=Promise.resolve();
  const repo={getBooking:async code=>records.get(code),withSlot:(_id,fn)=>{
    const run=pending.then(async()=>{
      const writes=[];
      const result=await fn({slot,bookings:[...records.values()],className:'1L',create:b=>writes.push(b),update:b=>writes.push(b)});
      writes.forEach(b=>records.set(b.code,b));return result;
    });
    pending=run.catch(()=>{}); return run;
  }};
  return {service:createService(repo,()=>Date.UTC(2026,8,17)),records,slot};
}
test('server ignores client supplied state, capacity, assigned class and code',async()=>{
  const h=setup(); const b=await h.service.book({...form,type:'entrato',postiMax:999,classeAssegnata:'admin',code:'fake'});
  assert.equal(b.type,'prenotazione');assert.equal(b.classeAssegnata,'1L');assert.match(b.code,/^MS-[A-F0-9]{24}$/);assert.equal(b.requestId,undefined);
});
test('40 concurrent requests produce exactly 25 confirmed and 15 waiting',async()=>{
  const h=setup(25);
  const result=await Promise.all(Array.from({length:40},(_,i)=>h.service.book({...form,nome:`Studente ${i}`,email:`test${i}@example.invalid`,requestId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`})));
  assert.equal(result.filter(b=>b.type==='prenotazione').length,25);
  assert.equal(result.filter(b=>b.type==='lista_attesa').length,15);
});
test('retry after a lost response returns the same booking',async()=>{
  const h=setup();const first=await h.service.book(form);const retry=await h.service.book(form);
  assert.equal(first.code,retry.code);assert.equal(h.records.size,1);
});
test('a new request id cannot bypass duplicate detection',async()=>{
  const h=setup();await h.service.book(form);
  await assert.rejects(h.service.book({...form,requestId:'00000000-0000-4000-8000-000000000002'}),e=>e.code==='DUPLICATE');
});
test('lookup requires matching email and high entropy code',async()=>{
  const h=setup();const b=await h.service.book(form);
  await assert.rejects(h.service.lookup(b.code,'other@example.invalid'),e=>e.code==='NOT_FOUND');
  await assert.rejects(h.service.lookup('MS-123456',form.email),e=>e.code==='NOT_FOUND');
  assert.equal((await h.service.lookup(b.code,form.email)).nome,form.nome);
});
test('unauthorized cancellation changes nothing',async()=>{
  const h=setup();const b=await h.service.book(form);
  await assert.rejects(h.service.cancel(b.code,'other@example.invalid'));
  assert.equal(h.records.get(b.code).type,'prenotazione');
});
test('cancellation promotes the oldest queued booking and is idempotent',async()=>{
  const h=setup();const first=await h.service.book(form);
  const next=await h.service.book({...form,nome:'Secondo Studente',email:'next@example.invalid',requestId:'00000000-0000-4000-8000-000000000002'});
  await h.service.cancel(first.code,form.email);await h.service.cancel(first.code,form.email);
  assert.equal(h.records.get(first.code).type,'cancellazione');assert.equal(h.records.get(next.code).type,'prenotazione');
});
test('checked-in students cannot self-cancel',async()=>{
  const h=setup();const b=await h.service.book(form);h.records.set(b.code,{...h.records.get(b.code),type:'entrato'});
  await assert.rejects(h.service.cancel(b.code,form.email),e=>e.code==='INVALID_STATE');
});
test('disabled and past slots reject bookings',async()=>{
  const h=setup();h.slot.active=false;await assert.rejects(h.service.book(form),e=>e.code==='SLOT_INACTIVE');
  h.slot.active=true;h.slot.isoDate='2020-01-01';await assert.rejects(h.service.book(form),e=>e.code==='SLOT_INACTIVE');
});
test('validation rejects missing consent, oversized text, invalid phone and pickup',()=>{
  for(const bad of [{declarationAccepted:false},{nome:'a'.repeat(121)},{cellulare:'abcdabcd'},{exitMode:'ritiro_adulto',pickupAdultName:''},{email:'bad'}, {slotId:'../secret'}]) assert.throws(()=>validateInput({...form,...bad}));
});
test('waiting-list cancellation does not overfill an already full slot',async()=>{
  const h=setup();const first=await h.service.book(form);
  const wait=await h.service.book({...form,nome:'Altro Studente',requestId:'00000000-0000-4000-8000-000000000002'});
  await h.service.cancel(wait.code,form.email);
  assert.equal(h.records.get(first.code).type,'prenotazione');
  assert.equal([...h.records.values()].filter(b=>b.type==='prenotazione').length,1);
});
