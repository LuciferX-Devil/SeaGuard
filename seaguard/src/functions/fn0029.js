// Alert notifier (Telegram). Each notification is a queued job with retry and backoff, so a
// failing messaging service delays alerts but never loses them. Test runs always talk to the
// local mock endpoint; live mode uses the real bot when a token is configured.
// Outputs: 1 = HTTP send, 2 = nothing (reserved)
const cfg = global.get('cfg');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;

let S = context.get('S');
if (!S || S.ep !== ep) { S = { ep, list: [] }; context.set('S', S); global.set('notifications', S.list); }
const live = global.get('mode') === 'live' && cfg.telegram.enabled && !!cfg.telegram.token;
const token = cfg.telegram.token || 'DEMO';
const chatFor = role => {
    if (role === 'family') return cfg.telegram.familyChatId || 'family-demo';
    if (role === 'coastguard') return cfg.telegram.coastGuardChatId || 'coastguard-demo';
    return cfg.telegram.coastGuardChatId || 'ops-demo';
};
const out = [];
function send(rec) {
    rec.attempts++; rec.inflight = true; rec.sentAt = t; rec.status = 'SENDING';
    out.push({
        topic: 'send',
        url: live ? 'https://api.telegram.org/bot' + token + '/sendMessage'
            : cfg.baseUrl + '/mock-telegram/bot' + token + '/sendMessage',
        headers: { 'content-type': 'application/json', 'x-seaguard-epoch': String(ep),
            'x-seaguard-delivery-id': ep + ':' + rec.id }, // durable idempotency key: epoch + notification id
        requestTimeout: 8000,
        payload: { chat_id: rec.chat, text: rec.text },
        _nid: rec.id, _ep: ep
    });
}

if (msg.topic === 'notify') {
    const p = msg.payload;
    for (const role of p.roles) {
        if (S.list.some(r => r.id === p.ref + '/' + role)) continue; // idempotent: never double-queue the same delivery
        S.list.push({ id: p.ref + '/' + role, ref: p.ref, incident: p.incident, kind: p.kind, role, chat: chatFor(role),
            severity: p.severity, text: p.text, status: 'QUEUED', attempts: 0, created: t, nextAt: t, inflight: false, deliveredAt: null, lastError: null, deliveryUncertain: false });
    }
} else if (msg.topic === 'test') {
    S.nextTestId = (S.nextTestId || 0) + 1;
    S.list.push({ id: 'TEST-' + t + '-' + S.nextTestId, ref: 'TEST', incident: null, kind: 'TEST', role: 'family', chat: chatFor('family'),
        severity: 1, text: 'SeaGuard test message (' + (live ? 'live bot' : 'local mock') + ')', status: 'QUEUED', attempts: 0, created: t, nextAt: t, inflight: false, deliveredAt: null, lastError: null, deliveryUncertain: false });
} else if (msg.topic === 'resp') {
    if (msg._ep === ep) {
        const rec = S.list.find(r => r.id === msg._nid);
        if (rec) {
            rec.inflight = false;
            const body = msg.payload;
            const ok = msg.statusCode === 200 && body && body.ok;
            if (ok) { rec.status = 'DELIVERED'; rec.deliveredAt = t; rec.lastError = null; rec.deliveryUncertain = false; }
            else {
                // deliveryUncertain (set by the store at restore) is deliberately NOT
                // touched here: a retry error only records THIS attempt's failure, the
                // earlier in-flight attempt's outcome remains unknown.
                rec.lastError = 'HTTP ' + (msg.statusCode || '?') + (body && body.description ? ' ' + body.description : '');
                if (rec.attempts >= cfg.retry.maxNotifyTries) rec.status = 'FAILED';
                else { rec.status = 'RETRY'; rec.nextAt = t + cfg.retry.notifyBackoff[Math.min(rec.attempts - 1, cfg.retry.notifyBackoff.length - 1)]; }
            }
        }
    }
} else if (msg.topic === 'tick') {
    for (const rec of S.list) {
        if (rec.inflight && t - rec.sentAt > 20) { rec.inflight = false; rec.status = rec.attempts >= cfg.retry.maxNotifyTries ? 'FAILED' : 'RETRY'; rec.nextAt = t + 2; rec.lastError = 'no response'; /* deliveryUncertain preserved */ }
        if (!rec.inflight && (rec.status === 'QUEUED' || rec.status === 'RETRY')) {
            // The retry budget is a hard cap even for records restored from a checkpoint: an
            // exhausted budget terminates FAILED here instead of dispatching attempt max+1.
            if (rec.attempts >= cfg.retry.maxNotifyTries) { rec.status = 'FAILED'; if (!rec.lastError) rec.lastError = 'retry budget exhausted'; /* deliveryUncertain preserved */ }
            else if (t >= rec.nextAt) send(rec);
        }
    }
}

// Retention: cap history at HISTORY rows but shed terminal records (DELIVERED/FAILED) first so
// an undelivered alert is never silently dropped. If the pending backlog alone exceeds the
// window, keep it whole and surface the overflow instead of fabricating delivery.
const HISTORY = 300;
const isTerminal = r => r.status === 'DELIVERED' || r.status === 'FAILED';
while (S.list.length > HISTORY) {
    const i = S.list.findIndex(isTerminal);
    if (i === -1) break;
    S.list.splice(i, 1);
}
S.backlog = S.list.filter(r => !isTerminal(r)).length;
S.backlogExceeded = S.backlog > HISTORY;
if (S.backlogExceeded && !S.backlogWarned) { S.backlogWarned = true; node.warn('notification backlog ' + S.backlog + ' exceeds history window ' + HISTORY); }
else if (!S.backlogExceeded) S.backlogWarned = false;

global.set('notifications', S.list);
return [out.length ? out : null];