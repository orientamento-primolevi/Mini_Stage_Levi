const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRepository,names}=require('../firestore-repository');
function repository(){
  const fixture={
    [names.bookings]:[{id:'MS-PRIVATE-CODE',nome:'PRIVATE_NAME',email:'private@example.invalid',cellulare:'PRIVATE_PHONE',requestId:'PRIVATE_REQUEST',slotId:'slot-1',type:'prenotazione'}],
    [names.scanner]:[{id:'PRIVATE_SCANNER',active:true}]
  };
  return createRepository({collection:path=>({get:async()=>({docs:(fixture[path.split('/').pop()]||[]).map(row=>({id:row.id,data:()=>row}))})})});
}
test('public availability never includes names, emails, phone numbers, booking codes or scanner tokens',async()=>{
  const state=await repository().state(false);
  const serialized=JSON.stringify(state);
  assert.doesNotMatch(serialized,/PRIVATE|private@example/);
  assert.equal(state.prenotazioni_v2.length,1);
  assert.equal(state.prenotazioni_v2[0].slotId,'slot-1');
  assert.equal(state.scanner_sessions.length,0);
});
test('staff state retains data needed for school administration',async()=>{
  const state=await repository().state(true);
  assert.equal(state.prenotazioni_v2[0].nome,'PRIVATE_NAME');
  assert.equal(state.scanner_sessions.length,1);
});
