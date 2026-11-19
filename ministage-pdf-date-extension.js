(() => {
  'use strict';

  const VERSION = '2026.11-pdf-per-data-v3';
  const ACTIVE = 'prenotazione';
  const WAITLIST = 'lista_attesa';
  const CHECKED = 'entrato';
  const EXITED = 'uscito';
  const CANCELLED = 'cancellazione';

  let core = null;
  let f = null;
  let slots = [];
  let bookings = [];
  let installed = false;

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const rootPath = (name) => `artifacts/${core.appId}/public/data/${name}`;
  const slotPath = () => rootPath(core.collections.impostazioni);
  const bookingPath = () => rootPath(core.collections.prenotazioni);

  function isoFromAny(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : '';
  }

  function dateIt(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  function weekdayIt(iso) {
    if (!iso) return '';
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    const value = new Intl.DateTimeFormat('it-IT', { weekday: 'long' }).format(d);
    return value ? value[0].toUpperCase() + value.slice(1) : '';
  }

  function normalizeSlot(data, id) {
    const raw = data || {};
    const isoDate = isoFromAny(raw.isoDate || raw.date || raw.data || raw.dateStr || '');
    return {
      ...raw,
      id: String(id || raw.id || ''),
      isoDate,
      dateStr: String(raw.dateStr || dateIt(isoDate) || '').trim(),
      day: String(raw.day || raw.giorno || weekdayIt(isoDate) || '').trim(),
      time: String(raw.time || raw.orario || '14:30 - 16:30').trim(),
      indirizzo: String(raw.indirizzo || '').trim()
    };
  }

  function displayAddress(address) {
    const raw = String(address || '').trim();
    if (typeof window.getIndirizzoLabel === 'function') return window.getIndirizzoLabel(raw);
    return raw.replace(/Scienze Applicate\s*(?:&|&amp;)\s*Curvatura Economica/gi, 'Scienze Applicate - Curvatura Economica');
  }

  function shortAddress(address) {
    const a = String(address || '').trim();
    if (a === 'Liceo Scientifico - Scienze Applicate') return 'Liceo Scienze Applicate';
    if (/curvatura economica/i.test(a)) return 'Liceo Curvatura Economica';
    if (/relazioni internazionali/i.test(a)) return 'RIM';
    if (/logistica/i.test(a)) return 'Logistica';
    if (/costruzion/i.test(a) || /territorio/i.test(a)) return 'CAT';
    if (/moda/i.test(a)) return 'Sistema Moda';
    return a || 'Percorso';
  }

  function statusLabel(type) {
    if (type === CHECKED) return 'Presente';
    if (type === EXITED) return 'Uscito';
    if (type === ACTIVE) return 'Prenotato';
    if (type === WAITLIST) return 'Lista attesa';
    if (type === CANCELLED) return 'Annullato';
    return String(type || '—');
  }

  const realTypes = new Set([ACTIVE, CHECKED, EXITED]);
  const uniqueByCode = rows => {
    const seen = new Set();
    return rows.filter(row => {
      const id = String(row.code || row.id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  function rowsForSlot(slotId, source = bookings) {
    return uniqueByCode(source.filter(b => b.slotId === slotId && realTypes.has(b.type)))
      .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'it'));
  }
  function waitRowsForSlot(slotId, source = bookings) {
    return uniqueByCode(source.filter(b => b.slotId === slotId && b.type === WAITLIST))
      .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  }
  function waitCount(slotId) { return waitRowsForSlot(slotId).length; }

  function ensureUi() {
    const page = document.getElementById('mini-page-pdf');
    if (!page) return null;

    const oldClassButtons = document.getElementById('mini-pages-class-pdfs');
    if (oldClassButtons) oldClassButtons.style.display = 'none';

    let block = document.getElementById('mini-pdf-per-date-block');
    if (!block) {
      block = document.createElement('div');
      block.id = 'mini-pdf-per-date-block';
      block.className = 'glass-card p-5 border-l-4 border-indigo-500 space-y-4';
      block.innerHTML = `
        <div>
          <h2 class="text-lg font-black text-indigo-950">PDF per singola data e percorso</h2>
          <p class="text-xs text-gray-500">Ogni data ha un download separato per ciascun MiniStage. I due licei sono sempre distinti: Scienze Applicate e Curvatura Economica non vengono mai uniti.</p>
        </div>
        <div id="mini-pdf-date-groups" class="space-y-3"></div>`;
      page.appendChild(block);
    }
    return document.getElementById('mini-pdf-date-groups');
  }

  function render() {
    const root = ensureUi();
    if (!root) return;

    const sorted = [...slots]
      .filter(s => s.id && s.indirizzo)
      .sort((a, b) => `${a.isoDate || a.dateStr}|${a.indirizzo}|${a.time}`.localeCompare(`${b.isoDate || b.dateStr}|${b.indirizzo}|${b.time}`));

    const groups = new Map();
    for (const slot of sorted) {
      const key = slot.isoDate || isoFromAny(slot.dateStr) || slot.dateStr || 'Senza data';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(slot);
    }

    root.innerHTML = [...groups.entries()].map(([key, group]) => {
      const first = group[0] || {};
      const iso = isoFromAny(key) || first.isoDate;
      const label = `${first.day || weekdayIt(iso)} ${first.dateStr || dateIt(iso)}`.trim() || key;
      const buttons = group.map(slot => {
        const rows = rowsForSlot(slot.id).length;
        const waits = waitCount(slot.id);
        return `<button type="button" onclick="window.downloadMiniStageSlotPdf('${esc(slot.id)}')" class="w-full sm:w-auto text-left bg-white border border-indigo-200 hover:border-indigo-400 hover:bg-indigo-50 text-indigo-800 px-4 py-3 rounded-xl text-[10px] font-black transition shadow-sm">
          <span class="block text-[11px]">Scarica PDF – ${esc(shortAddress(slot.indirizzo))}</span>
          <span class="block mt-1 text-[9px] font-semibold text-gray-500">${esc(slot.time)} · ${rows} partecipanti${waits ? ` · ${waits} in attesa` : ''}</span>
        </button>`;
      }).join('');
      return `<section class="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-4">
        <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div class="min-w-[190px]"><p class="text-[9px] font-black uppercase tracking-wider text-indigo-500">Data MiniStage</p><h3 class="text-sm font-black text-indigo-950">${esc(label)}</h3></div>
          <div class="flex flex-col sm:flex-row sm:flex-wrap gap-2 flex-1 lg:justify-end">${buttons}</div>
        </div>
      </section>`;
    }).join('') || '<p class="text-xs text-gray-400 italic text-center py-6">Nessuna data MiniStage configurata.</p>';
  }

  function sanitizeFileName(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 90) || 'MiniStage';
  }

  // A4 orizzontale = 297 x 210 mm. Testo entro i confini e righe senza barrature.
  function fit(pdf, raw, width) {
    let value = String(raw ?? '-').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() || '-';
    while (value.length > 1 && pdf.getTextWidth(value) > width) value = value.slice(0, -2) + '.';
    return value;
  }
  const confirmedCols = [
    ['N.', 9, (_r, i) => i + 1], ['Studente', 49, r => r.nome],
    ['Codice', 28, r => r.code || r.id], ['Stato', 26, r => statusLabel(r.type)],
    ['E-mail', 68, r => r.email], ['Telefono', 38, r => r.cellulare],
    ['Uscita', 59, r => r.exitMode === 'autonoma' ? 'Autonoma' : r.exitMode === 'ritiro_adulto' ? 'Ritiro adulto' : '-']
  ];
  const waitingCols = [
    ['Pos.', 11, (_r, i) => i + 1], ['Studente', 50, r => r.nome],
    ['Codice', 28, r => r.code || r.id], ['Data', 26, r => r.stageDate],
    ['E-mail', 68, r => r.email], ['Telefono', 38, r => r.cellulare],
    ['Situazione', 56, () => 'IN ATTESA - NON AMMESSO']
  ];
  function drawTable(pdf, heading, rows, cols, startY) {
    const bottom = pdf.internal.pageSize.getHeight() - 14;
    let y = startY;
    const next = continued => {
      pdf.addPage();
      y = 15;
      if (continued) {
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(35, 49, 96);
        pdf.text(heading + ' (continua)', 11, y);
        y += 7;
      }
    };
    if (y + 23 > bottom) next(false);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11); pdf.setTextColor(35, 49, 96);
    pdf.text(heading + ' - Totale: ' + rows.length, 11, y + 4);
    y += 9;
    const header = () => {
      pdf.setFillColor(224, 233, 250); pdf.rect(10, y, 277, 9, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.8); pdf.setTextColor(31, 41, 85);
      let x = 10;
      for (const [label, width] of cols) { pdf.text(fit(pdf, label, width - 3), x + 1.5, y + 5.7); x += width; }
      y += 9;
    };
    header();
    if (!rows.length) {
      pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8);
      pdf.setTextColor(95, 105, 120); pdf.text('Nessun nominativo per questa sezione.', 12, y + 5);
      return y + 14;
    }
    for (let i = 0; i < rows.length; i++) {
      if (y + 8.5 > bottom) { next(true); header(); }
      if (i % 2 === 0) { pdf.setFillColor(247, 249, 252); pdf.rect(10, y, 277, 8.5, 'F'); }
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(44, 50, 62);
      let x = 10;
      for (const [_label, width, getter] of cols) {
        pdf.text(fit(pdf, getter(rows[i], i), width - 3), x + 1.5, y + 5.6);
        x += width;
      }
      y += 8.5;
    }
    return y + 7;
  }
  function footers(pdf) {
    const total = pdf.getNumberOfPages();
    for (let n = 1; n <= total; n++) {
      pdf.setPage(n); pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(110, 110, 120); pdf.setFontSize(7.5);
      pdf.text('Primo Levi Seregno - Elenchi ad uso interno', 11, 204);
      pdf.text('Pagina ' + n + ' / ' + total, 286, 204, {align: 'right'});
    }
  }
  async function downloadSlotPdf(slotId) {
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return window.showMessage?.('Data MiniStage non trovata.', true);
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return window.showMessage?.('Generatore PDF non disponibile.', true);
    let current = [];
    try {
      const snap = await f.getDocs(f.collection(core.db, bookingPath()));
      snap.forEach(d => current.push({ ...d.data(), id: d.id, code: d.data().code || d.id }));
    } catch (err) {
      console.error('MiniStage: lettura elenchi PDF', err);
      return window.showMessage?.('Lettura degli iscritti non riuscita: PDF non generato.', true);
    }
    const rows = rowsForSlot(slotId, current);
    const waiting = waitRowsForSlot(slotId, current);
    const pdf = new jsPDF('l', 'mm', 'a4');
    pdf.setFillColor(35, 49, 96); pdf.rect(0, 0, 297, 17, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(14); pdf.text('ITSCG Primo Levi Seregno - Mini Stage', 11, 11);
    pdf.setTextColor(35, 49, 96); pdf.setFontSize(12);
    pdf.text(fit(pdf, shortAddress(slot.indirizzo), 272), 11, 25);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(64, 72, 89);
    pdf.text('Data: ' + (slot.day || weekdayIt(slot.isoDate)) + ' ' + (slot.dateStr || dateIt(slot.isoDate)) +
      '     Ora: ' + (slot.time || '-'), 11, 33);
    pdf.text('Iscritti reali: ' + rows.length + '     Presenti: ' + rows.filter(r => r.type === CHECKED).length +
      '     Usciti: ' + rows.filter(r => r.type === EXITED).length +
      '     Lista di attesa: ' + waiting.length, 11, 41);
    const y = drawTable(pdf, 'A - ISCRITTI CONFERMATI', rows, confirmedCols, 48);
    drawTable(pdf, 'B - LISTA DI ATTESA (NON AMMESSI)', waiting, waitingCols, y);
    footers(pdf);
    pdf.save('MiniStage_' + sanitizeFileName(slot.dateStr || slot.isoDate) + '_' +
      sanitizeFileName(shortAddress(slot.indirizzo)) + '.pdf');
  }

  function subscribe() {
    f.onSnapshot(f.collection(core.db, slotPath()), snap => {
      slots = [];
      snap.forEach(d => slots.push(normalizeSlot(d.data(), d.id)));
      render();
    }, err => console.warn('MiniStage PDF per data - date:', err));

    f.onSnapshot(f.collection(core.db, bookingPath()), snap => {
      bookings = [];
      snap.forEach(d => bookings.push({ id: d.id, code: d.data().code || d.id, ...d.data() }));
      render();
    }, err => console.warn('MiniStage PDF per data - prenotazioni:', err));
  }

  function init() {
    if (installed) return;
    core = window.__miniStageCore;
    f = window.firebaseImports;
    if (!core?.db || !core?.collections?.impostazioni || !core?.collections?.prenotazioni || !f?.onSnapshot || !f?.collection) {
      setTimeout(init, 150);
      return;
    }
    if (core.auth && !core.auth.currentUser) {
      setTimeout(init, 150);
      return;
    }
    installed = true;
    window.downloadMiniStageSlotPdf = downloadSlotPdf;
    subscribe();
    const shellRetry = setInterval(() => {
      if (document.getElementById('mini-page-pdf')) {
        render();
        clearInterval(shellRetry);
      }
    }, 500);
    setTimeout(() => { if (document.getElementById('mini-page-pdf')) render(); }, 250);
    window.__MINISTAGE_PDF_DATE_EXTENSION__ = { version: VERSION };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0), { once: true });
  } else {
    setTimeout(init, 0);
  }
})();
