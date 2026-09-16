// Adattatore del sito esistente: nessun accesso Firestore diretto dal browser.
export function installBackendClient(sdk) {
  const apiUrl = ['localhost','127.0.0.1'].includes(location.hostname)
    ? '/api'
    : 'https://europe-west1-mini-stage-levi.cloudfunctions.net/bookingApi';
  const root = 'artifacts/ClJzJkLPS6LWHAzKjLQe/public/data/';
  let state = null;
  let pending = null;
  let updatedAt = 0;
  const listeners = new Set();
  const receipts = new Map();
  const requestIds = new Map();
  async function request(action, data = {}) {
    const headers = { 'Content-Type':'application/json' };
    const user = window.__miniStageCore?.auth?.currentUser;
    if (user && !user.isAnonymous) headers.Authorization = `Bearer ${await user.getIdToken()}`;
    let response;
    try { response = await fetch(apiUrl, { method:'POST', headers, body:JSON.stringify({action,data}), signal:AbortSignal.timeout(25000) }); }
    catch { throw Object.assign(new Error('Il servizio prenotazioni non è raggiungibile. Riprova: i dati del modulo sono conservati.'), { code:'unavailable' }); }
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.message || 'Servizio non disponibile'), { code:body.error });
    return body;
  }
  async function load(force = false) {
    if (!force && state && Date.now()-updatedAt < 3000) return state;
    if (pending) return pending;
    pending = request('state').then(result=>{ state=result; updatedAt=Date.now(); return result; }).finally(()=>{pending=null;});
    return pending;
  }
  const ref = (_db,...segments) => (typeof _db==='string' ? [_db,...segments] : segments).map(s=>typeof s==='string'?s:s.path).join('/');
  const docSnapshot = (value,id) => ({ id, exists:()=>value != null, data:()=>value, metadata:{fromCache:false} });
  async function snapshot(path) {
    const value = await load();
    const suffix = path.slice(root.length);
    const slash = suffix.indexOf('/');
    const name = slash < 0 ? suffix : suffix.slice(0,slash);
    const id = slash < 0 ? null : suffix.slice(slash+1);
    const rows = value.collections[name] || [];
    if (id !== null) return docSnapshot(rows.find(r=>r.id===id) || receipts.get(id),id);
    const docs = rows.map(r=>docSnapshot(r,r.id));
    return { docs, size:docs.length, empty:!docs.length, metadata:{fromCache:false}, forEach:callback=>docs.forEach(callback) };
  }
  async function refresh() {
    try { await load(true); await Promise.all([...listeners].map(async l=>{ try { l.next(await snapshot(l.path)); } catch(e) { l.error?.(e); } })); }
    catch(e) { listeners.forEach(l=>l.error?.(e)); }
  }
  const wrapped = {
    ...sdk, doc:ref, collection:ref, getDoc:snapshot, getDocs:snapshot,
    onSnapshot(path,...args) {
      if (typeof args[0] !== 'function') args.shift();
      const listener = { path, next:args[0], error:args[1] }; listeners.add(listener);
      snapshot(path).then(listener.next,listener.error || (()=>{}));
      return ()=>listeners.delete(listener);
    },
    async setDoc(path,value,options) {
      await request('admin-write',{path,value,operation:'set',merge:options?.merge===true}); await refresh();
    },
    async updateDoc(path,value) {
      await request('admin-write',{path,value,operation:'update'}); await refresh();
    },
    async deleteDoc(path) { await request('admin-write',{path,operation:'delete'}); await refresh(); },
    runTransaction() { throw new Error('Le transazioni sono gestite esclusivamente dal backend'); }
  };
  window.miniStageBackend = {
    request, refresh, isAdmin:()=>state?.admin===true,
    async book(form) {
      const fingerprint = JSON.stringify(form);
      if (!requestIds.has(fingerprint)) requestIds.set(fingerprint,crypto.randomUUID());
      const result = await request('book',{...form,requestId:requestIds.get(fingerprint)});
      receipts.set(result.code,result); refresh(); return result;
    },
    async lookup(code,email) { const result = await request('lookup',{code,email}); receipts.set(result.code,result); return result; },
    async cancel(code,email) { const result = await request('cancel',{code,email}); receipts.set(result.code,result); refresh(); return result; }
  };
  setInterval(()=>{ if (!document.hidden && listeners.size) refresh(); },15000);
  window.addEventListener('online',refresh);
  return wrapped;
}
