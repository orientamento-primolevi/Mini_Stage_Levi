/* MiniStage Levi — coda mail aggiuntiva, senza modifiche ai flussi esistenti. */
(() => {
  'use strict';
  if (window.__MINI_MAIL_QUEUE_LOADED__) return;
  window.__MINI_MAIL_QUEUE_LOADED__ = true;

  const TYPES = ['promemoria', 'ingresso', 'pergamena'];
  const LABELS = { promemoria: 'Promemoria', ingresso: 'Conferma / pass ingresso', pergamena: 'Pergamena partecipazione' };
  const ACTIVE = new Set(['prenotazione', 'entrato', 'uscito']);
  const WORK_INTERVAL_MS = 3500;
  const owner = 'docente-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  let core, f, loopBusy = false, batchBusy = false, rowObserver = null, legacySend = null, lastError = '';

  const el = id => document.getElementById(id);
  const esc = x => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const nowLabel = ts => ts ? new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date(Number(ts))) : '—';
  const all = () => Array.isArray(core?.getBookings?.()) ? core.getBookings() : [];
  const get = code => all().find(b => (b.code || b.id) === code);
  const path = () => 'artifacts/' + core.appId + '/public/data/' + core.collections.prenotazioni;
  const ref = code => f.doc(core.db, path() + '/' + code);
  const eligible = b => b && ACTIVE.has(b.type) && !!b.email && !!(b.code || b.id);
  const admin = () => !!(core?.auth?.currentUser && el('view-admin') && !el('view-admin').classList.contains('hidden') &&
    el('admin-dashboard') && !el('admin-dashboard').classList.contains('hidden') &&
    el('admin-login') && el('admin-login').classList.contains('hidden'));
  const notify = (message, error = false) => window.showMessage?.(message, error);

  function getHistory(b, kind) {
    const h = b?.mailHistory?.[kind] || {};
    const q = b?.mailQueue?.[kind] || {};
    if (h.lastAt) return { at: h.lastAt, label: 'Richiesta registrata', q };
    if (kind === 'promemoria' && b.reminderRequestedAt) return { at: b.reminderRequestedAt, label: 'Richiesta registrata', q };
    if (kind === 'promemoria' && b.reminderSent) return { at: 0, label: 'Già segnato (ora non disponibile)', q };
    if (kind === 'pergamena' && b.certificateSentAt) return { at: b.certificateSentAt, label: 'Invio registrato dal sistema', q };
    if (kind === 'pergamena' && b.certificateSent) return { at: 0, label: 'Già segnato (ora non disponibile)', q };
    return { at: 0, label: 'Nessuna richiesta registrata', q };
  }

  function statusHtml(b, kind) {
    const { at, label, q } = getHistory(b, kind);
    let status = at ? label + ' il ' + nowLabel(at) : label;
    if (q.status === 'queued') status = 'In coda dal ' + nowLabel(q.queuedAt);
    else if (q.status === 'sending') status = q.leaseUntil < Date.now()
      ? 'Tentativo interrotto: esito da verificare'
      : 'Invio in lavorazione dal ' + nowLabel(q.startedAt);
    else if (q.status === 'failed') status = 'Errore ultimo tentativo (' + nowLabel(q.failedAt) + ')' + (at ? '; precedente: ' + nowLabel(at) : '');
    else if (q.status === 'submitted') status = 'Richiesta inoltrata il ' + nowLabel(q.submittedAt);
    const allowed = kind !== 'pergamena' || ['entrato', 'uscito'].includes(b.type);
    const busy = q.status === 'queued' || (q.status === 'sending' && Number(q.leaseUntil) > Date.now());
    const hadPrevious = !!at || (kind === 'promemoria' && b.reminderSent) || (kind === 'pergamena' && b.certificateSent);
    const btnLabel = !allowed ? 'Dopo la presenza' : busy ? 'Già in coda' : hadPrevious ? 'Rinvia' : 'Invia';
    return '<div class="flex gap-2 items-center justify-between rounded-lg bg-white border border-slate-100 px-2 py-1.5">' +
      '<div class="min-w-0"><p class="text-[9px] font-black uppercase text-indigo-700">' + LABELS[kind] +
      '</p><p class="text-[10px] text-slate-600 break-words">' + esc(status) + '</p></div>' +
      '<button type="button" data-mini-mail-kind="' + kind + '" data-mini-mail-code="' + esc(b.code || b.id) + '" ' +
      ((!allowed || busy) ? 'disabled ' : '') + 'class="shrink-0 rounded-md py-1.5 px-2 text-[10px] font-black ' +
      ((!allowed || busy) ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 hover:bg-indigo-700 text-white') + '">' + btnLabel + '</button></div>';
  }

  function renderRows() {
    const root = el('mini-pages-book-list');
    if (!root || !admin()) return;
    root.querySelectorAll(':scope > article').forEach(article => {
      const match = article.textContent.match(/\bMS-\d{6}\b/);
      const b = match ? get(match[0]) : null;
      if (!b || !eligible(b)) return;
      const key = TYPES.map(kind => {
        const q = b.mailQueue?.[kind] || {};
        const h = b.mailHistory?.[kind] || {};
        return [kind, q.status, q.queuedAt, q.startedAt, q.submittedAt, q.failedAt, q.leaseUntil,
          h.lastAt, b.reminderSent, b.reminderRequestedAt, b.certificateSent, b.certificateSentAt].join(':');
      }).join('|') + '|' + b.type;
      let side = article.querySelector('[data-mini-mail-sidebar]');
      if (side?.dataset.renderKey === key) return;
      if (!side) {
        side = document.createElement('aside');
        side.dataset.miniMailSidebar = '1';
        side.className = 'w-full lg:max-w-sm lg:shrink-0 rounded-xl border border-indigo-100 bg-indigo-50/50 p-2 space-y-1';
        const heading = document.createElement('p');
        heading.className = 'text-[10px] font-black text-indigo-900 mb-1';
        heading.textContent = 'Storico e-mail e reinvio';
        side.appendChild(heading);
        article.firstElementChild?.appendChild(side);
      }
      side.dataset.renderKey = key;
      side.innerHTML = '<p class="text-[10px] font-black text-indigo-900 mb-1">Storico e-mail e reinvio</p>' +
        TYPES.map(kind => statusHtml(b, kind)).join('');
    });
  }

  function panelMarkup() {
    return '<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">' +
      '<div><h3 class="font-black text-indigo-950 text-base">Motore e-mail Mini Stage</h3>' +
      '<p class="text-[11px] text-slate-600 mt-1">Coda persistente su Firebase. Il motore elabora le richieste mentre l’Area Docenti rimane aperta.</p></div>' +
      '<button type="button" data-mini-mail-all class="bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs rounded-xl px-4 py-3">Invia i promemoria a tutti gli iscritti</button></div>' +
      '<div data-mini-mail-stats class="text-[11px] font-semibold text-indigo-900 bg-indigo-50 border border-indigo-100 rounded-xl p-3 mt-3">Caricamento coda...</div>' +
      '<p class="text-[10px] text-slate-500 mt-2">La data/ora indica una richiesta inoltrata o registrata, non la consegna nella casella. I servizi Google Apps Script attuali non restituiscono una ricevuta di consegna verificabile.</p>';
  }

  function ensurePanels() {
    const configs = [
      ['mini-pages-home', 'mini-mail-home'],
      ['mini-book-sub-active', 'mini-mail-bookings']
    ];
    for (const [parentId, id] of configs) {
      const parent = el(parentId);
      if (!parent || el(id)) continue;
      const section = document.createElement('section');
      section.id = id;
      section.className = 'glass-card p-4 sm:p-5 border-l-4 border-indigo-600';
      section.innerHTML = panelMarkup();
      parent.insertBefore(section, parent.firstElementChild);
    }
    const list = el('mini-pages-book-list');
    if (list && !rowObserver) {
      rowObserver = new MutationObserver(renderRows);
      rowObserver.observe(list, { childList: true });
    }
  }

  function renderPanels() {
    if (!admin()) return;
    ensurePanels();
    const entries = all().filter(eligible);
    const pending = entries.reduce((n, b) => n + TYPES.filter(kind => b.mailQueue?.[kind]?.status === 'queued').length, 0);
    const sending = entries.reduce((n, b) => n + TYPES.filter(kind => b.mailQueue?.[kind]?.status === 'sending').length, 0);
    const failed = entries.reduce((n, b) => n + TYPES.filter(kind => b.mailQueue?.[kind]?.status === 'failed').length, 0);
    const stats = 'Iscritti: ' + entries.length + ' · In coda: ' + pending + ' · In lavorazione: ' + sending +
      ' · Errori: ' + failed + (lastError ? ' · Attenzione: ' + lastError : '') +
      (batchBusy ? ' · Accodamento in corso...' : '');
    document.querySelectorAll('[data-mini-mail-stats]').forEach(node => {
      if (node.textContent !== stats) node.textContent = stats;
    });
    renderRows();
  }

  async function enqueueOne(code, kind) {
    if (!admin() || !TYPES.includes(kind)) throw new Error('Operazione riservata ai docenti');
    const docRef = ref(code);
    return f.runTransaction(core.db, async tx => {
      const snap = await tx.get(docRef);
      if (!snap.exists()) return 'missing';
      const b = snap.data();
      if (!eligible({ ...b, code: b.code || code })) return 'invalid';
      if (kind === 'pergamena' && !['entrato', 'uscito'].includes(b.type)) return 'not_present';
      const prev = b.mailQueue?.[kind] || {};
      if (prev.status === 'queued' || (prev.status === 'sending' && Number(prev.leaseUntil || 0) > Date.now())) return 'already';
      const queuedAt = Date.now();
      tx.update(docRef, { ['mailQueue.' + kind]: {
        id: owner + '-' + queuedAt + '-' + kind,
        status: 'queued', queuedAt, startedAt: 0, submittedAt: 0, failedAt: 0,
        leaseUntil: 0, processingOwner: '', attempts: Number(prev.attempts || 0), error: ''
      } });
      return 'queued';
    });
  }

  async function enqueueAll() {
    if (!admin() || batchBusy) return;
    const entries = all().filter(eligible);
    if (!entries.length) return notify('Nessun iscritto attivo con indirizzo e-mail.', true);
    if (!confirm('Accodare il promemoria per tutti i ' + entries.length +
      ' iscritti? Verrà reinviato anche a chi lo ha già ricevuto. Le richieste già in coda non saranno duplicate.')) return;
    batchBusy = true;
    let queued = 0, skipped = 0, failed = 0;
    renderPanels();
    try {
      // Una prenotazione per transazione: niente nuove collezioni o regole Firestore.
      for (const b of entries) {
        try {
          const r = await enqueueOne(b.code || b.id, 'promemoria');
          if (r === 'queued') queued++;
          else skipped++;
        } catch (e) {
          failed++;
          console.warn('MiniStage coda: impossibile accodare ' + b.code, e);
        }
      }
      notify('Promemoria accodati: ' + queued + '. Già in coda/non idonei: ' + skipped +
        (failed ? '. Errori: ' + failed : '') + '. Mantieni aperta l’Area Docenti.', !!failed);
    } finally {
      batchBusy = false;
      renderPanels();
      processNext();
    }
  }

  async function enqueueManual(code, kind) {
    if (!admin()) return notify('Accedi prima all’Area Docenti.', true);
    try {
      const result = await enqueueOne(code, kind);
      const msg = {
        queued: LABELS[kind] + ' per ' + code + ' aggiunto alla coda.',
        already: 'Questo messaggio è già in coda o in lavorazione.',
        not_present: 'Pergamena disponibile solo per studenti presenti o usciti.',
        invalid: 'Studente non idoneo o prenotazione annullata.',
        missing: 'Prenotazione non trovata.'
      };
      notify(msg[result] || 'Richiesta non accodata.', result !== 'queued' && result !== 'already');
      renderPanels();
      if (result === 'queued') processNext();
    } catch (e) {
      console.warn('MiniStage coda: errore accodamento', e);
      notify('Impossibile salvare la coda su Firebase: ' + (e?.code || e?.message || e), true);
    }
  }

  async function claim(code, kind, id) {
    return f.runTransaction(core.db, async tx => {
      const docRef = ref(code);
      const snap = await tx.get(docRef);
      if (!snap.exists()) return null;
      const b = snap.data();
      const job = b.mailQueue?.[kind];
      if (!job || job.status !== 'queued' || job.id !== id) return null;
      if (!eligible({ ...b, code: b.code || code }) ||
        (kind === 'pergamena' && !['entrato', 'uscito'].includes(b.type))) {
        tx.update(docRef, { ['mailQueue.' + kind]: { ...job, status: 'skipped', error: 'Prenotazione non idonea' } });
        return null;
      }
      const startedAt = Date.now();
      tx.update(docRef, { ['mailQueue.' + kind]: {
        ...job, status: 'sending', startedAt, leaseUntil: startedAt + 120000,
        processingOwner: owner, attempts: (Number(job.attempts) || 0) + 1
      } });
      return { ...b, code: b.code || code, job: { ...job, startedAt } };
    });
  }

  async function postOpaque(url, payload) {
    if (!url || !/^https:\/\/script\.google\.com\/macros\/s\//.test(url)) throw new Error('Endpoint Google Apps Script mancante');
    // no-cors: non è possibile sapere se lo script abbia elaborato il messaggio.
    await fetch(url, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  }

  async function dispatch(b, kind) {
    const parts = String(b.nome || '').trim().split(/\s+/);
    const first = parts.shift() || '';
    const rest = parts.join(' ');
    const payload = {
      email: b.email, nome: first, cognome: rest, codice_prenotazione: b.code,
      data: b.stageDate, orario: b.stageTime, attivita: b.indirizzo
    };
    if (kind === 'promemoria') {
      await postOpaque(core.endpoints?.reminder, payload);
    } else if (kind === 'pergamena') {
      await postOpaque(core.endpoints?.certificate, {
        ...payload, classe_assegnata: b.classeAssegnata || '',
        tipo: 'attestato_partecipazione', stato: 'MINISTAGE CONCLUSO - USCITO'
      });
    } else {
      // Riutilizza il generatore PDF e il servizio di conferma già presenti.
      // Quel metodo gestisce i propri errori: qui si registra soltanto il tentativo.
      if (typeof legacySend !== 'function') throw new Error('Motore conferme/PDF non disponibile');
      await legacySend({ ...b, type: b.type === 'uscito' ? 'prenotazione' : b.type }, true);
    }
  }

  async function finish(code, kind, id, succeeded, error) {
    await f.runTransaction(core.db, async tx => {
      const docRef = ref(code);
      const snap = await tx.get(docRef);
      if (!snap.exists()) return;
      const b = snap.data();
      const job = b.mailQueue?.[kind] || {};
      if (job.id !== id || job.processingOwner !== owner || job.status !== 'sending') return;
      const at = Date.now();
      const previous = b.mailHistory?.[kind] || {};
      const update = {
        ['mailQueue.' + kind]: { ...job, status: succeeded ? 'submitted' : 'failed',
          submittedAt: succeeded ? at : 0, failedAt: succeeded ? 0 : at,
          leaseUntil: 0, processingOwner: '', error: succeeded ? '' : String(error).slice(0, 200) }
      };
      if (succeeded) {
        const events = Array.isArray(previous.events) ? previous.events.slice(-7) : [];
        events.push({ at, event: kind === 'ingresso' ? 'tentativo_di_conferma' : 'richiesta_inoltrata' });
        update['mailHistory.' + kind] = {
          ...previous, lastAt: at, lastResult: kind === 'ingresso' ? 'tentativo_non_verificato' : 'inoltrato_non_verificato',
          count: (Number(previous.count) || 0) + 1, events
        };
        if (kind === 'promemoria') {
          // Compatibilità con il contatore e il filtro del sito preesistente.
          update.reminderSent = true;
          update.reminderRequestedAt = at;
        }
        // Non aggiornare certificateSent/type: la chiusura automatica esistente deve restare integra.
      }
      tx.update(docRef, update);
    });
  }

  async function processNext() {
    if (loopBusy || !admin() || batchBusy) return;
    loopBusy = true;
    try {
      const candidates = [];
      for (const b of all()) {
        for (const kind of TYPES) {
          const q = b.mailQueue?.[kind];
          if (q?.status === 'queued' && q.id) candidates.push({
            code: b.code || b.id, kind, id: q.id, queuedAt: Number(q.queuedAt) || 0
          });
        }
      }
      candidates.sort((a, b) => a.queuedAt - b.queuedAt);
      for (const item of candidates) {
        const b = await claim(item.code, item.kind, item.id);
        if (!b) continue;
        try {
          await dispatch(b, item.kind);
          await finish(item.code, item.kind, item.id, true, '');
          lastError = '';
        } catch (e) {
          console.error('MiniStage: errore richiesta mail', item.code, item.kind, e);
          lastError = String(e?.message || e).slice(0, 120);
          await finish(item.code, item.kind, item.id, false, lastError);
        }
        break; // Un invio alla volta per evitare raffiche a Google Apps Script.
      }
    } catch (e) {
      lastError = String(e?.code || e?.message || e).slice(0, 120);
      console.warn('MiniStage: motore coda temporaneamente bloccato', e);
    } finally {
      loopBusy = false;
      renderPanels();
    }
  }

  function installConfirmationAudit() {
    const current = window.sendAutomaticEmailNotification;
    if (typeof current !== 'function' || current.__miniMailAudited) return;
    legacySend = current;
    const audited = async function(booking, isRetrieval) {
      // Il flusso originale rimane invariato: registriamo solo l'esecuzione.
      let result;
      try { result = await current.apply(this, arguments); }
      finally {
        if (booking?.code && ACTIVE.has(booking.type) && f?.updateDoc) {
          // Nessuna ricevuta di consegna: non si afferma che l'e-mail sia arrivata.
          f.updateDoc(ref(booking.code), {
            'mailHistory.ingresso': {
              lastAt: Date.now(), lastResult: 'tentativo_non_verificato',
              lastOrigin: isRetrieval ? 'ristampa_ricevuta' : 'iscrizione_automatica'
            }
          }).catch(err => console.warn('MiniStage: storico conferma non salvato', err));
        }
      }
      return result;
    };
    audited.__miniMailAudited = true;
    window.sendAutomaticEmailNotification = audited;
  }

  function installClickHandler() {
    document.addEventListener('click', e => {
      const sendAll = e.target.closest('[data-mini-mail-all]');
      if (sendAll) { e.preventDefault(); enqueueAll(); return; }
      const button = e.target.closest('[data-mini-mail-kind][data-mini-mail-code]');
      if (button) {
        e.preventDefault();
        enqueueManual(button.dataset.miniMailCode, button.dataset.miniMailKind);
      }
    });
  }

  function init() {
    core = window.__miniStageCore;
    f = window.firebaseImports;
    if (!core?.db || !f?.runTransaction || !f?.doc || !f?.updateDoc) {
      setTimeout(init, 300);
      return;
    }
    installClickHandler();
    ensurePanels();
    installConfirmationAudit();
    renderPanels();
    // La pagina pubblica non esegue alcun invio. Il motore parte solo da Area Docenti autenticata.
    setInterval(() => {
      installConfirmationAudit();
      if (!admin()) return;
      renderPanels();
      processNext();
    }, WORK_INTERVAL_MS);
    window.__MINI_MAIL_QUEUE__ = { version: '2026-11-19', processNext };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();