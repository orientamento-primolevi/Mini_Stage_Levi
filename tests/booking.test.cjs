const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ministage-complete.js'), 'utf8');
const form = { slotId: 'slot-1', indirizzo: 'Liceo', nome: 'Test Studente', scuola: 'Test', email: 'test@example.invalid', cellulare: '3331234567', exitMode: 'autonoma', parentGuardianName: 'Test Genitore', parentGuardianRole: 'genitore', declarationAccepted: true };

function harness(options = {}) {
  const writes = [];
  let locks = 0;
  const slot = { indirizzo: 'Liceo', day: 'Venerdì', dateStr: '06/11/2026', time: '14:30 - 16:30', postiMax: 1, active: true, ...options.slot };
  const snapshot = (data, id = 'slot-1') => ({ id, exists: () => !!data, data: () => data });
  const f = {
    doc: (_db, p) => p,
    collection: (_db, p) => p,
    runTransaction: async (_db, callback) => {
      locks++;
      if (options.lockError) throw options.lockError;
      return callback({ get: async () => snapshot(options.lock), set: () => {} });
    },
    getDocs: async p => ({ forEach: cb => {
      const rows = p.endsWith('/bookings') ? (options.bookings || []) : [];
      rows.forEach((row, i) => cb(snapshot(row, String(i))));
    } }),
    getDoc: async p => p.includes('/slots/') ? snapshot(options.missingSlot ? null : slot) : snapshot(null),
    setDoc: async (p, data) => {
      if (p.includes('/bookings/') && options.writeError) throw options.writeError;
      writes.push({ path: p, data });
    }
  };
  const core = { db: {}, appId: 'test', collections: { prenotazioni: 'bookings', impostazioni: 'slots', capacita: 'caps' }, waitForAuth: async () => { if (options.authError) throw options.authError; } };
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} }, console: { warn() {} }, setTimeout() {}, URLSearchParams };
  vm.createContext(context);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `window.__test = { saveSubmission, acquireLock, setup(c, sdk) { core = c; f = sdk; slots = [{ id: 'slot-1', active: true }]; } }; })();`), context);
  context.window.__test.setup(core, f);
  return { api: context.window.__test, writes, locks: () => locks };
}

test('permission denied is not reported as a busy slot', async () => {
  const error = Object.assign(new Error('denied'), { code: 'permission-denied' });
  const h = harness({ lockError: error });
  await assert.rejects(h.api.saveSubmission(form), e => e === error);
  assert.equal(h.writes.length, 0);
});
test('authentication failure prevents all database writes', async () => {
  const h = harness({ authError: new Error('not authenticated') });
  await assert.rejects(h.api.saveSubmission(form), /not authenticated/);
  assert.equal(h.locks(), 0);
});
test('a disabled slot is checked against the current database, not stale UI state', async () => {
  const h = harness({ slot: { active: false } });
  await assert.rejects(h.api.saveSubmission(form), /SLOT_INACTIVE/);
  assert.equal(h.writes.filter(x => x.path.includes('/bookings/')).length, 0);
  assert.equal(h.writes.length, 1); // release lock
});
test('removed slots cannot be booked', async () => {
  const h = harness({ missingSlot: true });
  await assert.rejects(h.api.saveSubmission(form), /SLOT_NOT_FOUND/);
});
test('duplicate requests cannot be saved', async () => {
  const h = harness({ bookings: [{ ...form, type: 'prenotazione' }] });
  await assert.rejects(h.api.saveSubmission(form), /DUPLICATE/);
});
test('a free slot saves a confirmed booking before returning', async () => {
  const h = harness();
  const result = await h.api.saveSubmission(form);
  assert.equal(result.type, 'prenotazione');
  assert.equal(h.writes[0].data.code, result.code);
  assert.equal(result.stageDate, '06/11/2026');
});
test('full slots place new requests on the waiting list', async () => {
  const h = harness({ bookings: [{ slotId: 'slot-1', type: 'prenotazione', nome: 'Altro', email: 'altro@example.invalid' }] });
  const result = await h.api.saveSubmission(form);
  assert.equal(result.type, 'lista_attesa');
});
test('a failed booking write does not return a confirmation and releases the lock', async () => {
  const h = harness({ writeError: new Error('write failed') });
  await assert.rejects(h.api.saveSubmission(form), /write failed/);
  assert.equal(h.writes.length, 1);
  assert.match(h.writes[0].path, /ministage_slot_locks/);
});
test('a genuinely held lock remains a busy slot', async () => {
  const h = harness({ lock: { owner: 'other', lockedUntil: Date.now() + 60000 } });
  await assert.rejects(h.api.saveSubmission(form), /SLOT_BUSY/);
});
test('all JavaScript parses, including inline module scripts', () => {
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.js'))) new vm.Script(fs.readFileSync(path.join(root, name), 'utf8').replace(/^export /gm,''));
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    new vm.Script(match[1].replace(/^\s*import .*?;\s*$/gm, ''));
  }
});
