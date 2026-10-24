// GET /seaguard/test/status - machine readable state of the current or last campaign.
const T = global.get('test') || {};
msg.payload = {
    state: T.state || 'IDLE', seed: T.seed ?? null, t: global.get('simTime') || 0, duration: T.D || null,
    faults: (T.schedule || []).length,
    results: T.results ? { pass: T.results.pass, fail: T.results.fail, skip: T.results.skip, verdict: T.results.verdict, wallSec: T.results.wallSec,
        rows: T.results.rows } : null,
    history: T.history || []
};
msg.statusCode = 200;
return msg;
