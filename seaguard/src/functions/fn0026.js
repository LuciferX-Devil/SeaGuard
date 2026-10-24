// Marine API response -> keep wave data, then request wind from the forecast API.
// On failure skip straight to the evaluator with the error attached.
if (msg.statusCode === 200 && Array.isArray(msg.payload)) {
    msg.wx.marine = msg.payload.map(r => (r && r.current) || {});
    msg.url = msg.wx.forecastUrl;
    msg.payload = undefined;
    delete msg.headers; delete msg.statusCode; delete msg.responseUrl; delete msg.redirectList; delete msg.retry;
    return [msg, null];
}
msg.wx.error = 'Marine API ' + (msg.statusCode || 'no response') + (typeof msg.payload === 'string' ? ': ' + msg.payload.slice(0, 80) : '');
return [null, msg];
