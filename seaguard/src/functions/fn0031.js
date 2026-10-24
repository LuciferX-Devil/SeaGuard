// Local Telegram mock. Records what would have been sent and can fail on demand, which is how
// the "messaging service down" fault is tested without touching the real Telegram API.
const lib = global.get('lib');
const t = global.get('simTime') || 0;
const faults = global.get('faults') || [];
const body = msg.payload || {};
const log = global.get('mockTelegram') || [];
const ref = (/Ref: (\S+)/.exec(body.text || '') || [])[1] || null;
if (lib.findFault(faults, t, null, 'TELEGRAM_OUTAGE')) {
    log.push({ t, chat: body.chat_id, ref, ok: false, text: body.text, note: 'rejected: injected outage' });
    global.set('mockTelegram', log.slice(-300));
    msg.statusCode = 502;
    msg.payload = { ok: false, error_code: 502, description: 'Bad Gateway (injected outage)' };
    return msg;
}
log.push({ t, chat: body.chat_id, ref, ok: true, text: body.text });
global.set('mockTelegram', log.slice(-300));
msg.statusCode = 200;
msg.payload = { ok: true, result: { message_id: log.length, chat: { id: body.chat_id }, date: Math.floor(Date.now() / 1000), text: body.text } };
return msg;
