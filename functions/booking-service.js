'use strict';
const { randomBytes } = require('node:crypto');
const ACTIVE = new Set(['prenotazione', 'entrato', 'uscito']);
class ApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new ApiError(code, message, status); }
function text(value, name, min, max) {
  if (typeof value !== 'string') fail('INVALID_INPUT', `Campo non valido: ${name}`);
  const result = value.trim().replace(/\s+/g, ' ');
  if (result.length < min || result.length > max || /[<>\x00-\x1f]/.test(result)) fail('INVALID_INPUT', `Campo non valido: ${name}`);
  return result;
}
function validateInput(input) {
  const d = {};
  for (const [name, min, max] of [['slotId',1,120], ['nome',3,120], ['scuola',2,180], ['email',5,254], ['cellulare',7,30], ['parentGuardianName',3,120], ['parentGuardianRole',2,60]]) d[name] = text(input[name], name, min, max);
  if (!/^[A-Za-z0-9_-]+$/.test(d.slotId)) fail('INVALID_INPUT', 'Slot non valido');
  d.email = d.email.toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(d.email)) fail('INVALID_INPUT', 'Email non valida');
  if (!/^\+?[\d ().-]+$/.test(d.cellulare) || d.cellulare.replace(/\D/g,'').length < 7 || d.cellulare.replace(/\D/g,'').length > 15) fail('INVALID_INPUT', 'Cellulare non valido');
  if (!['autonoma','ritiro_adulto'].includes(input.exitMode) || input.declarationAccepted !== true) fail('INVALID_INPUT', 'Conferma la modalità di uscita');
  d.exitMode = input.exitMode;
  d.pickupAdultName = d.exitMode === 'ritiro_adulto' ? text(input.pickupAdultName, 'pickupAdultName', 3, 120) : '';
  d.declarationAccepted = true;
  d.requestId = text(input.requestId, 'requestId', 16, 100);
  if (!/^[a-zA-Z0-9-]+$/.test(d.requestId)) fail('INVALID_INPUT', 'Identificativo richiesta non valido');
  return d;
}
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g,' ');
function publicBooking(b) {
  const { requestId, ...visible } = b;
  return visible;
}
function createService(repository, now = Date.now) {
  return {
    async book(input) {
      const d = validateInput(input);
      return repository.withSlot(d.slotId, async ctx => {
        const sameRequest = ctx.bookings.find(b => b.requestId === d.requestId);
        if (sameRequest) {
          if (sameRequest.email !== d.email || normalize(sameRequest.nome) !== normalize(d.nome)) fail('CONFLICT', 'Richiesta già utilizzata', 409);
          return publicBooking(sameRequest);
        }
        const slot = ctx.slot;
        if (!slot || slot.active === false) fail('SLOT_INACTIVE', 'MiniStage non disponibile', 409);
        const today = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
        const clock = new Date(now()).toLocaleTimeString('it-IT', { timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit' });
        const end = String(slot.time || '').match(/(\d{1,2}:\d{2})\s*$/)?.[1]?.padStart(5,'0');
        if (slot.isoDate && (slot.isoDate < today || (slot.isoDate === today && end && clock >= end))) fail('SLOT_INACTIVE', 'MiniStage concluso', 409);
        if (ctx.bookings.some(b => b.type !== 'cancellazione' && normalize(b.nome) === normalize(d.nome) && normalize(b.email) === d.email)) fail('DUPLICATE', 'Risulta già una richiesta per questo studente e questa data', 409);
        const occupied = ctx.bookings.filter(b => ACTIVE.has(b.type)).length;
        const queue = ctx.bookings.filter(b => b.type === 'lista_attesa');
        const type = occupied >= slot.postiMax || queue.length ? 'lista_attesa' : 'prenotazione';
        const stamp = now();
        const b = { ...d, code: 'MS-' + randomBytes(12).toString('hex').toUpperCase(), type,
          indirizzo: slot.indirizzo, stageDay: slot.day, stageDate: slot.dateStr, stageTime: slot.time,
          classeAssegnata: ctx.className || 'Da definire', timestamp: stamp,
          reminderSent: false, certificateSent: false, declarationTimestamp: stamp,
          declarationVersion: 'MiniStage-2026-backend-v1', exitAuthorizationAccepted: true,
          exitAuthorizationMode: d.exitMode, exitAuthorizationAcceptedAt: stamp,
          exitAuthorizationVersion: 'MiniStage-uscita-autorizzazione-v2',
          authorizationPaperRequired: d.exitMode === 'autonoma', authorizationPaperReceived: false };
        if (type === 'lista_attesa') Object.assign(b, { waitlistRequestedAt: stamp, waitlistStatus: 'Iscrizione con riserva', iscrizioneConRiserva: true });
        ctx.create(b);
        return publicBooking(b);
      });
    },
    async lookup(code, email) {
      if (!/^MS-[A-F0-9]{24}$/.test(code || '') || typeof email !== 'string') fail('NOT_FOUND', 'Prenotazione non trovata', 404);
      const booking = await repository.getBooking(code);
      if (!booking || normalize(booking.email) !== normalize(email)) fail('NOT_FOUND', 'Prenotazione non trovata', 404);
      return publicBooking(booking);
    },
    async cancel(code, email) {
      const booking = await this.lookup(code, email);
      return repository.withSlot(booking.slotId, async ctx => {
        const current = ctx.bookings.find(b => b.code === code);
        if (!current || normalize(current.email) !== normalize(email)) fail('NOT_FOUND', 'Prenotazione non trovata', 404);
        if (current.type === 'cancellazione') return publicBooking(current);
        if (!['prenotazione','lista_attesa'].includes(current.type)) fail('INVALID_STATE', 'Prenotazione non più annullabile', 409);
        const cancelled = { ...current, type: 'cancellazione', cancelledAt: now() };
        ctx.update(cancelled);
        const live = ctx.bookings.filter(b => b.code !== code && ACTIVE.has(b.type)).length;
        const queue = ctx.bookings.filter(b => b.code !== code && b.type === 'lista_attesa').sort((a,b) => a.timestamp - b.timestamp || a.code.localeCompare(b.code));
        if (ctx.slot?.active !== false && live < ctx.slot.postiMax && queue.length) {
          const first = queue[0];
          ctx.update({ ...first, type: 'prenotazione', waitlistPromotedAt: now(), waitlistPromotionStatus: 'Ammesso da scorrimento', iscrizioneConRiserva: false });
        }
        return publicBooking(cancelled);
      });
    }
  };
}
module.exports = { createService, validateInput, ApiError, ACTIVE, publicBooking };
