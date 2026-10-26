// Local Telegram mock. Records what would have been sent and can fail on demand, which is how
// the "messaging service down" fault is tested without touching the real Telegram API.
// Durable idempotency: every send carries x-seaguard-delivery-id (epoch + notification id).
// The ledger (global.mockDeliveryLedger) is the source of truth for accepted deliveries, so a
// replayed delivery returns the SAME simulated message_id without a second success effect or
// log line. The simulated message_id comes from a monotonic counter (mockDeliverySeq),
// independent of the 300-row log ring, so original and replay always agree. Stale-epoch
// requests, injected-outage failures and checkpoint-save failures never create a confirmed
// record; a failed checkpoint rolls back the new effects and returns 503 so the notifier
// keeps the job retryable instead of marking it delivered.
const lib = global.get('lib');
const t = global.get('simTime') || 0;
const faults = global.get('faults') || [];
const body = msg.payload || {};
const log = global.get('mockTelegram') || [];
const ref = (/Ref: (\S+)/.exec(body.text || '') || [])[1] || null;
const hdr = (msg.req && msg.req.headers) || {};
const deliveryId = hdr['x-seaguard-delivery-id'];
const hasId = typeof deliveryId === 'string' && deliveryId.length > 0 && deliveryId.length <= 128;
const reqEpoch = hdr['x-seaguard-epoch'] !== undefined ? Number(hdr['x-seaguard-epoch']) : null;
let ledger = global.get('mockDeliveryLedger');
if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) { ledger = {}; global.set('mockDeliveryLedger', ledger); }
// A confirmed record is an OWN property with a well-formed shape. Inherited properties
// (toString/constructor/...) or malformed values must not fake a completed delivery.
const record = (id) => {
    if (!hasId || !Object.prototype.hasOwnProperty.call(ledger, id)) return null;
    const r = ledger[id];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.message_id !== 'number' || !Number.isFinite(r.message_id) || r.message_id < 1) return null;
    if (typeof r.chat !== 'string' || typeof r.text !== 'string' || typeof r.date !== 'number' || !Number.isFinite(r.date)) return null;
    return r;
};
const reject = (code, description, note) => {
    log.push({ t, chat: body.chat_id, ref, ok: false, text: body.text, note: 'rejected: ' + note });
    global.set('mockTelegram', log.slice(-300));
    msg.statusCode = code;
    msg.payload = { ok: false, error_code: code, description };
    return msg;
};

// Stale epoch: the world was reset (newWorld bumps epoch) while this request was in flight.
// Reject without a confirmed ledger record; the notifier ignores the reply via its own _ep check.
if (reqEpoch !== null && reqEpoch !== (global.get('epoch') || 0)) {
    return reject(409, 'Conflict (stale epoch)', 'stale epoch ' + reqEpoch);
}
// Replay of an already-accepted delivery: same simulated message_id, no second success effect/log.
const done = record(deliveryId);
if (done) {
    // Key reuse with a changed payload is a conflict, never a success for a different message.
    if (done.chat !== body.chat_id || done.text !== body.text) {
        return reject(409, 'Conflict (delivery id reused with different payload)', 'delivery id reused with different payload');
    }
    msg.statusCode = 200;
    msg.payload = { ok: true, dedup: true, result: { message_id: done.message_id, chat: { id: done.chat }, date: done.date, text: body.text } };
    return msg;
}
if (lib.findFault(faults, t, null, 'TELEGRAM_OUTAGE')) {
    return reject(502, 'Bad Gateway (injected outage)', 'injected outage');
}
// First-time delivery. Stable simulated message_id from a monotonic counter, independent of
// the 300-row log ring length, so the original response and any later replay always agree.
const date = Math.floor(Date.now() / 1000);
const message_id = (Number(global.get('mockDeliverySeq')) || 0) + 1;
const nextLog = log.concat([{ t, chat: body.chat_id, ref, ok: true, text: body.text }]);
const nextLedger = Object.assign({}, ledger, hasId ? { [deliveryId]: { message_id, chat: body.chat_id, text: body.text, date, t } } : {});
// Persist the ledger and success log BEFORE confirming the delivery so a restart sees the
// accepted delivery. A failed checkpoint must NOT confirm: roll back the new effects and
// return 503 so the notifier keeps the job retryable (and a cached retry cannot claim
// durability that was never written).
global.set('mockDeliverySeq', message_id);
global.set('mockTelegram', nextLog.slice(-300));
global.set('mockDeliveryLedger', nextLedger);
const rt = global.get('fleetRuntime');
if (rt && typeof rt.save === 'function') {
    const r = rt.save(global);
    if (r && !r.ok) {
        global.set('mockTelegram', log.slice(-300));
        global.set('mockDeliveryLedger', ledger);
        global.set('mockDeliverySeq', message_id - 1);
        log.push({ t, chat: body.chat_id, ref, ok: false, text: body.text, note: 'rejected: checkpoint save failed (' + (r.error || 'unknown') + '); delivery not confirmed' });
        global.set('mockTelegram', log.slice(-300));
        msg.statusCode = 503;
        msg.payload = { ok: false, error_code: 503, description: 'Service Unavailable (checkpoint save failed; delivery not confirmed)' };
        return msg;
    }
}
msg.statusCode = 200;
msg.payload = { ok: true, result: { message_id, chat: { id: body.chat_id }, date, text: body.text } };
return msg;
