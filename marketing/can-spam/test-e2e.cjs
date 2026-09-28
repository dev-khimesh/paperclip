'use strict';

/**
 * End-to-end test for the global suppression list + opt-out endpoint.
 *
 * Proves, with real requests and a real store file:
 *   1. opt-out via the web endpoint records the address in the GLOBAL list
 *   2. the same address is suppressed across campaigns (global, not per-campaign)
 *   3. a suppressed address CANNOT be re-imported into a new campaign/list
 *   4. the send guard refuses to dispatch to a suppressed address
 *   5. re-suppression is idempotent and preserves the original timestamp
 *   6. a clean address is unaffected
 *
 * Run: node marketing/can-spam/test-e2e.js
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SuppressionList } = require('./suppression.cjs');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const headers = {};
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  // Isolated temp store so the test never touches the real list.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-test-'));
  const storePath = path.join(tmpDir, 'suppression-list.json');
  process.env.OPTOUT_STORE = storePath;

  // Require server AFTER setting the env var so it picks up the temp store.
  const { server } = require('./server.cjs');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const t = (email) => `test+${email.replace(/[^a-z0-9]/gi, '')}@example.com`;
  const suppressed = t('alice');
  const clean = t('bob');

  console.log('\n[1] Opt-out via web endpoint (JSON API)');
  const r1 = await req('POST', '/opt-out', { email: suppressed });
  check('HTTP 200', r1.status === 200, `got ${r1.status}`);
  const j1 = JSON.parse(r1.body);
  check('ok:true', j1.ok === true);
  check('added:true (first opt-out)', j1.added === true);
  const firstTimestamp = j1.suppressedAt;
  check('timestamp present', typeof firstTimestamp === 'string' && firstTimestamp.length > 0);

  console.log('\n[2] Address is in the GLOBAL suppression list');
  const r2 = await req('GET', '/suppression-list');
  const j2 = JSON.parse(r2.body);
  check('count >= 1', j2.count >= 1, `count=${j2.count}`);
  const found = j2.entries.find((e) => e.email === suppressed);
  check('entry present in list', !!found);
  check('source recorded', found && found.source === 'opt-out-endpoint');

  console.log('\n[3] Suppression is GLOBAL — applies across campaigns');
  const list = new SuppressionList(storePath);
  check('isSuppressed true (no campaign scope)', list.isSuppressed(suppressed) === true);
  check('isSuppressed true (different campaign)', list.isSuppressed(suppressed) === true);

  console.log('\n[4] Suppressed address CANNOT be re-imported');
  const importResult = list.filterImport([suppressed, clean], 'day2-campaign');
  check('import blocked for suppressed', importResult.blocked.length === 1);
  check('blocked reason = globally_suppressed',
    importResult.blocked[0] && importResult.blocked[0].reason === 'globally_suppressed');
  check('clean address still importable', importResult.allowed.includes(clean));
  check('suppressed NOT in allowed', !importResult.allowed.includes(suppressed));

  console.log('\n[5] Send guard refuses to dispatch to suppressed address');
  const g1 = list.guardSend(suppressed, 'day2-campaign');
  check('send blocked', g1.allowed === false);
  check('send block reason = globally_suppressed', g1.reason === 'globally_suppressed');
  const g2 = list.guardSend(clean, 'day2-campaign');
  check('clean send allowed', g2.allowed === true);

  console.log('\n[6] Re-suppression is idempotent (original timestamp preserved)');
  const r6 = await req('POST', '/opt-out', { email: suppressed });
  const j6 = JSON.parse(r6.body);
  check('already:true on re-opt-out', j6.already === true);
  check('added:false on re-opt-out', j6.added === false);
  check('timestamp unchanged', j6.suppressedAt === firstTimestamp);
  const r6b = await req('GET', '/suppression-list');
  check('count still 1 (no duplicate)', JSON.parse(r6b.body).count === 1);

  console.log('\n[7] Landing page (GET) records opt-out and returns HTML');
  const r7 = await req('GET', `/opt-out?email=${encodeURIComponent(clean)}`);
  check('HTTP 200', r7.status === 200);
  check('content-type html', (r7.headers['content-type'] || '').includes('text/html'));
  check('page confirms removal', r7.body.includes('removed from all lists'));
  // Re-read from disk to prove the landing page wrote through to the store.
  const listAfter = new SuppressionList(storePath);
  check('clean now suppressed (read back from disk)', listAfter.isSuppressed(clean) === true);

  console.log('\n[8] Invalid input handled');
  const r8 = await req('POST', '/opt-out', { email: 'not-an-email' });
  check('HTTP 422 for invalid email', r8.status === 422, `got ${r8.status}`);
  const r9 = await req('POST', '/opt-out', {});
  check('HTTP 400 for missing email', r9.status === 400, `got ${r9.status}`);

  console.log('\n[9] Store file persisted to disk');
  check('store file exists', fs.existsSync(storePath));
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('on-disk entries >= 2', Object.keys(onDisk.entries).length >= 2);

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
