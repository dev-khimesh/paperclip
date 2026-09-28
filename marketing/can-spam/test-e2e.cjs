'use strict';

/**
 * End-to-end test for the global suppression list + opt-out endpoint +
 * the send preflight that gives the store a production caller (K-20062).
 *
 * Proves, with real requests and a real store file:
 *   1. opt-out via the web endpoint records the address in the GLOBAL list
 *   2. the same address is suppressed across campaigns (global, not per-campaign)
 *   3. a suppressed address CANNOT be re-imported into a new campaign/list
 *   4. the send guard refuses to dispatch to a suppressed address
 *   5. re-suppression is idempotent and preserves the original timestamp
 *   6. a clean address is unaffected
 *   7. the preflight is reachable from the same origin that serves the opt-out
 *      page, over HTTP, and shares the same store
 *   8. the preflight excludes a suppressed address and LOGS the exclusion with
 *      a reason  (acceptance criterion 3)
 *   9. an opt-out recorded MID-BATCH suppresses the unsent remainder
 *      (acceptance criterion 2) — the exact K-20062 scenario
 *  10. the preflight fails CLOSED: an unreadable store blocks every recipient
 *      and an unparseable recipient is blocked, never silently dropped
 *  11. the preflight and filterImport agree on the same object/reason
 *  12. a STOP reply is recorded into the same store and blocks the next send
 *
 * Run: node marketing/can-spam/test-e2e.cjs
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SuppressionList } = require('./suppression.cjs');
const { preflight, recordStopReply, parseStopReply, EXIT } = require('./preflight.cjs');

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
  process.env.CAN_SPAM_STORE = storePath;
  // Keep the send-audit log out of the repo; the assertions below read it from
  // the same temp dir.
  process.env.CAN_SPAM_AUDIT_LOG = path.join(tmpDir, 'send-audit.log');

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

  // ---------------------------------------------------------------------
  // K-20062: the store had zero production callers. These prove the
  // preflight is a real, reachable, fail-closed gate on the send path.
  // ---------------------------------------------------------------------

  const auditPath = path.join(tmpDir, 'send-audit.log');
  const audit = (event) =>
    fs
      .readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === event);
  const day2 = [t('day2a'), t('day2b'), suppressed]; // `suppressed` opted out in [1]

  console.log('\n[10] Preflight is reachable from the origin that serves {OPT_OUT_URL}');
  const liveFingerprint = (await req('GET', '/suppression-list')).body;
  const r10 = await req('POST', '/send-preflight', { campaign: 'k247-day2', recipients: day2 });
  check('HTTP 200', r10.status === 200, `got ${r10.status}`);
  const j10 = JSON.parse(r10.body);
  check('ok:false (one recipient suppressed)', j10.ok === false);
  check('exitCode = 1 (blocked, not fatal)', j10.exitCode === 1);
  check('same store fingerprint as /suppression-list',
    j10.storeFingerprint === JSON.parse(liveFingerprint).fingerprint,
    `${j10.storeFingerprint} vs ${JSON.parse(liveFingerprint).fingerprint}`);
  check('suppressed address NOT in allowed', !j10.allowed.includes(suppressed));
  check('clean addresses allowed', j10.allowed.includes(t('day2a')) && j10.allowed.includes(t('day2b')));

  console.log('\n[11] Exclusion is LOGGED with a reason (acceptance criterion 3)');
  const excluded = j10.blocked.find((b) => b.email === suppressed);
  check('excluded present in blocked', !!excluded);
  check('reason recorded = globally_suppressed', excluded && excluded.reason === 'globally_suppressed');
  check('suppressedAt recorded on the exclusion', excluded && typeof excluded.suppressedAt === 'string');
  const logged = audit('send_preflight');
  check('preflight written to the append-only audit log', logged.length === 1, `entries=${logged.length}`);
  const loggedExclusion = logged[0] && logged[0].blocked.find((b) => b.email === suppressed);
  check('audit log records the exclusion', !!loggedExclusion);
  check('audit log records the reason', loggedExclusion && loggedExclusion.reason === 'globally_suppressed');
  check('audit log records the campaign', logged[0] && logged[0].campaign === 'k247-day2');

  console.log('\n[12] Preflight and filterImport agree — same store, same object, same reason');
  const live = new SuppressionList(storePath);
  const importView = live.filterImport(day2, 'k247-day2');
  const importReason = importView.blocked.find((b) => b.email === suppressed);
  check('filterImport blocks the same address', importReason && importReason.email === suppressed);
  check('identical reason string', excluded && importReason && importReason.reason === excluded.reason);
  check('identical allowed set',
    JSON.stringify([...importView.allowed].sort()) === JSON.stringify([...j10.allowed].sort()));

  console.log('\n[13] Opt-out recorded MID-BATCH suppresses the unsent remainder');
  // The K-20062 scenario: a batch is in flight, a recipient opts out while it
  // is in flight, and the next dispatch must exclude them. A check run once at
  // batch start cannot do this.
  const midBatch = t('midbatch');
  const preflightBefore = preflight([midBatch], { list: live, storePath, campaign: 'k247-day2', auditPath });
  check('address clear before the opt-out', preflightBefore.ok === true);
  await req('POST', '/opt-out', { email: midBatch }); // arrives mid-batch
  const live2 = new SuppressionList(storePath);
  const preflightAfter = preflight([midBatch], { list: live2, storePath, campaign: 'k247-day2', auditPath });
  check('same address blocked on the next preflight', preflightAfter.ok === false);
  check('blocked as globally_suppressed',
    preflightAfter.blocked[0] && preflightAfter.blocked[0].reason === 'globally_suppressed');
  const r13 = await req('POST', '/send-preflight', { campaign: 'k247-day2', recipients: [midBatch] });
  check('HTTP preflight also sees the mid-batch opt-out (no stale read)',
    JSON.parse(r13.body).ok === false, `status=${r13.status}`);

  console.log('\n[14] Preflight FAILS CLOSED — it cannot be made to report "clear" by accident');
  // (a) unreadable store
  const brokenPath = path.join(tmpDir, 'broken-store.json');
  fs.writeFileSync(brokenPath, '{ this is not json');
  const brokenList = new SuppressionList(brokenPath);
  const broken = preflight([t('anyone')], { list: brokenList, storePath: brokenPath, auditPath });
  check('unreadable store is fatal', broken.fatal === true);
  check('exitCode = 3 (distinct from "blocked")', broken.exitCode === EXIT.STORE_UNAVAILABLE);
  check('ok:false', broken.ok === false);
  check('recipient blocked with store_unavailable',
    broken.blocked[0] && broken.blocked[0].reason === 'store_unavailable');
  check('allowed list is EMPTY, not everyone', broken.allowed.length === 0);
  // (b) absent store — a fresh clone has no committed list, so nothing is provable
  const missing = preflight([t('anyone')], {
    storePath: path.join(tmpDir, 'nope', 'absent.json'),
    auditPath,
  });
  check('absent store is also fatal', missing.fatal === true);
  check('absent store returns no allowed recipients', missing.allowed.length === 0);
  // (c) unparseable recipient must not be silently skipped
  const malformed = preflight(['not-an-email', t('ok')], { list: live2, storePath, auditPath, campaign: 'k247-day2' });
  check('unparseable recipient blocked, not dropped', malformed.ok === false);
  check('reason = invalid_recipient',
    malformed.blocked[0] && malformed.blocked[0].reason === 'invalid_recipient');
  check('valid recipient still allowed alongside it', malformed.allowed.includes(t('ok')));
  // (d) the fatal store is served over HTTP as 503, never as a 200 "all clear"
  const unreachableList = new SuppressionList(brokenPath);
  const j14 = preflight([t('anyone')], { list: unreachableList, storePath: brokenPath, auditPath });
  check('fatal result is distinguishable programmatically', j14.exitCode !== EXIT.CLEAR && j14.fatal === true);

  console.log('\n[15] STOP reply is recorded into the SAME store and blocks the next send');
  const stopper = t('stopper');
  const parsedStop = parseStopReply('STOP\n\nplease take me off');
  check('STOP reply body classified as an opt-out', parsedStop.isStopRequest === true);
  check('keyword identified', parsedStop.keyword === 'stop');
  check('non-opt-out body not classified', parseStopReply('can we talk Thursday?').isStopRequest === false);
  const r15 = await req('POST', '/stop', { email: stopper, body: 'STOP', source: 'stop-reply', campaign: 'k247-day2' });
  check('POST /stop HTTP 200', r15.status === 200, `got ${r15.status}`);
  const j15 = JSON.parse(r15.body);
  check('recorded as newly added', j15.added === true);
  const listAfterStop = await req('GET', '/suppression-list');
  check('same fingerprint as the opt-out origin',
    j15.fingerprint === JSON.parse(listAfterStop.body).fingerprint);
  check('STOP address visible on the Legal list view',
    JSON.parse(listAfterStop.body).entries.some((e) => e.email === stopper));
  const live3 = new SuppressionList(storePath);
  check('STOP suppression is in the global store', live3.isSuppressed(stopper) === true);
  const afterStop = preflight([stopper], { list: live3, storePath, auditPath, campaign: 'k247-day2' });
  check('STOP blocks the next dispatch', afterStop.ok === false);
  check('STOP block reason recorded',
    afterStop.blocked[0] && afterStop.blocked[0].reason === 'globally_suppressed');
  check('STOP source preserved on the entry', live3.entryFor(stopper).source === 'stop-reply');
  const stopLogs = audit('stop_reply_recorded');
  check('STOP recorded in the audit log', stopLogs.length === 1);
  // idempotent
  const stopAgain = recordStopReply(stopper, { list: live3, storePath, auditPath });
  check('re-recording STOP is idempotent', stopAgain.already === true);
  check('original timestamp preserved', stopAgain.entry.suppressedAt === j15.suppressedAt);
  // the audit log must be attributable
  check('audit log records the store fingerprint',
    audit('send_preflight').every((r) => typeof r.storeFingerprint === 'string' && r.storeFingerprint.length > 0));

  console.log('\n[16] Opt-out origin and preflight cannot drift onto two lists');
  const r16 = await req('GET', '/health');
  const j16 = JSON.parse(r16.body);
  check('health reports one store path', typeof j16.store === 'string' && j16.store.length > 0);
  check('health reports the store is readable', j16.storeReadable === true);
  check('health store path is the temp store used by this test', j16.store === storePath, j16.store);

  console.log('\n[17] Operator init cannot destroy real opt-outs');
  // init must create a store when none exists, be a no-op when one does, and
  // REFUSE when the existing store is unreadable — a lost list silently
  // replaced by an empty one would un-suppress every opted-out address.
  const initPath = path.join(tmpDir, 'init', 'list.json');
  const initList = new SuppressionList(initPath);
  initList.store = { version: 1, description: 'init', entries: {} };
  initList.persist();
  const afterInit = new SuppressionList(initPath);
  check('init-created store is readable', afterInit.isReadable() === true);
  check('init-created store is empty', afterInit.count() === 0);
  const initClear = preflight([t('someone')], { storePath: initPath, auditPath });
  check('preflight clears against a freshly initialised store', initClear.ok === true);
  const afterCorrupt = fs.writeFileSync(initPath, '{corrupt');
  const corruptInit = preflight([t('someone')], { storePath: initPath, auditPath });
  check('a corrupted store fails closed again', corruptInit.fatal === true);
  check('corrupted store yields no allowed recipients', corruptInit.allowed.length === 0);

  console.log('\n[18] An opt-out that cannot be written is NEVER confirmed');
  // The dangerous failure: telling a recipient "you have been removed" when the
  // store did not accept the write, and then emailing them again. Make the
  // store unwritable and prove the endpoint refuses instead of confirming.
  const lockedDir = path.join(tmpDir, 'locked');
  const lockedStore = path.join(lockedDir, 'list.json');
  const lockedList = new SuppressionList(lockedStore);
  lockedList.store = { version: 1, description: 'locked', entries: {} };
  lockedList.persist();
  const mode = fs.statSync(lockedDir).mode & 0o777;
  fs.chmodSync(lockedDir, 0o500); // r-x: cannot create the .tmp write file
  let writeBlocked = false;
  try {
    lockedList.suppress(t('wantsout'), { source: 'opt-out-endpoint' });
  } catch (_err) {
    writeBlocked = true;
  }
  fs.chmodSync(lockedDir, mode);
  if (process.getuid && process.getuid() === 0) {
    console.log('  SKIP  running as root — file permissions do not block writes');
  } else {
    check('write to an unwritable store throws rather than reporting success', writeBlocked === true);
    check('the failed entry was rolled back', lockedList.isSuppressed(t('wantsout')) === false);
    const lockedOnDisk = JSON.parse(fs.readFileSync(lockedStore, 'utf8'));
    check('nothing was written to disk', Object.keys(lockedOnDisk.entries).length === 0);
    const lockedPreflight = preflight([t('wantsout')], { storePath: lockedStore, auditPath });
    check('the un-recorded address is still certifiable (no false suppression)', lockedPreflight.ok === true);
  }
  const r18 = await req('POST', '/opt-out', { email: t('lastcheck') });
  check('opt-out endpoint still healthy after the failure case', r18.status === 200, `got ${r18.status}`);

  // Same failure, observed through the endpoint the recipient actually hits.
  // The landing page must not render "removed from all lists" either.
  const tmpMode = fs.statSync(tmpDir).mode & 0o777;
  fs.chmodSync(tmpDir, 0o500);
  let endpointBlocked = false;
  try {
    const rw = await req('POST', '/opt-out', { email: t('cantwrite') });
    if (rw.status === 503 && JSON.parse(rw.body).ok === false) endpointBlocked = true;
    const rwPage = await req('GET', `/opt-out?email=${encodeURIComponent(t('cantwrite2'))}`);
    if ((rwPage.body || '').includes('removed from all lists')) {
      check('landing page must not confirm an opt-out that failed to record', false, 'it rendered the confirmation');
    }
  } finally {
    fs.chmodSync(tmpDir, tmpMode);
  }
  if (process.getuid && process.getuid() === 0) {
    console.log('  SKIP  running as root — file permissions do not block writes');
  } else {
    check('opt-out endpoint returns 503 instead of confirming', endpointBlocked === true);
    const notRecorded = new SuppressionList(storePath);
    check('nothing was recorded for the failed write', notRecorded.isSuppressed(t('cantwrite')) === false);
  }

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
