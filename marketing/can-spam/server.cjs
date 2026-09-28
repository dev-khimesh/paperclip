'use strict';

/**
 * Opt-out endpoint — the {OPT_OUT_URL} the CAN-SPAM footer points at.
 *
 * Serves a landing page (GET /opt-out?email=...) that records the opt-out in
 * the global suppression list and confirms it to the requester, plus a JSON
 * API (POST /opt-out) for programmatic use and a read-only list view
 * (GET /suppression-list) so Legal can verify the store directly.
 *
 * The endpoint is domain-independent: it binds to a host/port and is fronted
 * by the verified sending domain (P3) when that lands. The suppression logic
 * it calls is the same global store the send guard and import guard use, so a
 * suppression recorded here is enforced everywhere immediately.
 */

const http = require('node:http');
const { SuppressionList, resolveStorePath } = require('./suppression.cjs');
const { preflight, recordStopReply, parseStopReply } = require('./preflight.cjs');

const PORT = Number(process.env.OPTOUT_PORT || 8787);
const HOST = process.env.OPTOUT_HOST || '127.0.0.1';

const STORE_PATH = resolveStorePath();
const list = new SuppressionList(STORE_PATH);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function landingPageHtml(email, result) {
  const escaped = String(email).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const confirmed = result.added || result.already;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opt-out confirmed</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding:1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .ok { color: #0a7d28; font-weight: 600; }
  .meta { color: #666; font-size: .9rem; margin-top: 1rem; }
  code { background:#f4f4f4; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>${confirmed ? 'You have been removed from all lists' : 'Opt-out request received'}</h1>
  <p class="${confirmed ? 'ok' : ''}">${confirmed
    ? 'Your address <strong>' + escaped + '</strong> has been added to our global suppression list. It is removed from every list, permanently, and cannot be re-imported into any campaign.'
    : 'We could not process that address. Please reply "STOP" to any message instead.'}</p>
  <p class="meta">Recorded at ${result.entry ? result.entry.suppressedAt : new Date().toISOString()} &middot; Source: ${result.entry ? result.entry.source : 'web'} &middot; List fingerprint: <code>${list.fingerprint()}</code></p>
</div>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      suppressed: list.count(),
      fingerprint: list.fingerprint(),
      store: STORE_PATH,
      storeReadable: list.isReadable(),
    });
  }

  // Send preflight. Served by the same origin, from the same in-process store,
  // that serves {OPT_OUT_URL} — so the send step and the opt-out page cannot
  // drift onto two different lists. The send step calls this immediately
  // before dispatch, not once at batch start.
  if (url.pathname === '/send-preflight' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_err) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_body' });
    }
    const recipients = Array.isArray(body.recipients)
      ? body.recipients
      : String(body.recipients || '').split(/[\s,;]+/).filter(Boolean);
    const report = preflight(recipients, { list, campaign: body.campaign ?? null });
    return sendJson(res, report.fatal ? 503 : 200, {
      ok: report.ok,
      fatal: report.fatal,
      exitCode: report.exitCode,
      storeReadable: report.storeReadable,
      storeFingerprint: report.storeFingerprint,
      campaign: report.campaign,
      checkedAt: report.checkedAt,
      allowed: report.allowed,
      blocked: report.blocked,
    });
  }

  // STOP / unsubscribe reply processing. Writes to the same global store the
  // preflight reads, so a reply opt-out takes effect on the very next dispatch.
  if (url.pathname === '/stop') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_err) {
      return sendJson(res, 400, { ok: false, reason: 'invalid_body' });
    }
    if (body.email === undefined && body.body !== undefined) {
      const parsed = parseStopReply(body.body);
      if (!parsed.isStopRequest) {
        return sendJson(res, 422, { ok: false, reason: 'not_a_stop_request' });
      }
    }
    let result;
    try {
      result = recordStopReply(body.email, {
        list,
        source: body.source || 'stop-reply',
        campaign: body.campaign ?? null,
      });
    } catch (err) {
      return sendJson(res, 503, { ok: false, reason: 'store_unavailable', detail: err.message });
    }
    if (!result.ok) {
      return sendJson(res, 422, { ok: false, reason: result.reason, email: result.email });
    }
    return sendJson(res, 200, {
      ok: true,
      added: result.added,
      already: result.already,
      suppressedAt: result.entry.suppressedAt,
      fingerprint: list.fingerprint(),
    });
  }

  if (url.pathname === '/suppression-list') {
    return sendJson(res, 200, {
      count: list.count(),
      fingerprint: list.fingerprint(),
      entries: list.list(),
    });
  }

  if (url.pathname === '/opt-out') {
    let email = url.searchParams.get('email');
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body || '{}');
        email = parsed.email || email;
      } catch (_err) {
        return sendJson(res, 400, { ok: false, reason: 'invalid_body' });
      }
    }
    if (!email) {
      return sendJson(res, 400, { ok: false, reason: 'missing_email' });
    }
    let result;
    try {
      result = list.suppress(email, { source: 'opt-out-endpoint' });
    } catch (err) {
      // The opt-out could not be written. Never confirm it — a recipient told
      // "you have been removed" who then receives another email is the worst
      // outcome this control has. 503 + no confirmation, and the sender's
      // preflight keeps this address blocked until the store is repaired.
      return sendJson(res, 503, { ok: false, reason: 'store_unavailable', detail: err.message });
    }
    if (!result.ok) {
      return sendJson(res, 422, { ok: false, reason: result.reason, email: result.email });
    }
    const wantsJson = req.method === 'POST' || (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      return sendJson(res, 200, {
        ok: true,
        added: result.added,
        already: result.already,
        suppressedAt: result.entry.suppressedAt,
        fingerprint: list.fingerprint(),
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(landingPageHtml(email, result));
  }

  return sendJson(res, 404, { ok: false, reason: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`opt-out endpoint listening on http://${HOST}:${PORT}\n`);
    process.stdout.write(`  landing page:  http://${HOST}:${PORT}/opt-out?email=you@example.com\n`);
    process.stdout.write(`  json api:     POST http://${HOST}:${PORT}/opt-out  {email}\n`);
    process.stdout.write(`  list view:    http://${HOST}:${PORT}/suppression-list\n`);
  });
}

module.exports = { server, list };
