// GET /seaguard/test/run?seed=123&speed=10 - starts a randomized campaign (used by the
// dashboard button and by scripted batch runs).
const q = msg.req.query || {};
function reject(status, error) { msg.statusCode = status; msg.payload = { ok: false, error }; return [null, msg]; }
const cfg = global.get('cfg');
if (!cfg || !cfg.test) return reject(503, 'SeaGuard is not configured yet');
const hasSeed = q.seed !== undefined && q.seed !== '';
if (hasSeed && (typeof q.seed !== 'string' || !/^\d+$/.test(q.seed) || !Number.isSafeInteger(Number(q.seed)) || Number(q.seed) > 4294967295)) return reject(400, 'seed must be an unsigned 32-bit decimal integer');
const seed = hasSeed ? Number(q.seed) : (Math.random() * 4294967296) >>> 0;
const hasSpeed = q.speed !== undefined && q.speed !== '';
const speed = hasSpeed ? Number(q.speed) : undefined;
if (hasSpeed && (typeof q.speed !== 'string' || !Number.isFinite(speed) || speed < 1 || speed > 30)) return reject(400, 'speed must be between 1 and 30');
if (['RUNNING', 'EVALUATING'].includes((global.get('test') || {}).state)) return reject(409, 'A campaign is already running; abort it before starting another');
msg.payload = { ok: true, seed, speed: speed || null, duration: cfg.test.durationS + cfg.test.drainS };
msg.statusCode = 200;
return [{ topic: 'cmd', payload: { cmd: 'run', seed, speed } }, msg];
