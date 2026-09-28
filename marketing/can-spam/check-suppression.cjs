'use strict';

/**
 * CLI tool for the Day-1 send agent to consult the global suppression list
 * before dispatch. This is the mitigation for D1: the send is performed by
 * an agent through a connection, not a code path, so the agent needs a
 * checkable way to verify suppression status.
 *
 * Usage:
 *   node marketing/can-spam/check-suppression.cjs check <email>
 *   node marketing/can-spam/check-suppression.cjs batch <file-with-one-email-per-line>
 *   node marketing/can-spam/check-suppression.cjs list
 *
 * Exit codes:
 *   0 = all clear (or listing)
 *   1 = at least one address is suppressed
 *   2 = usage error
 */

const fs = require('node:fs');
const path = require('node:path');
const { SuppressionList } = require('./suppression.cjs');

const STORE_PATH = process.env.OPTOUT_STORE || path.join(__dirname, 'suppression-list.json');
const list = new SuppressionList(STORE_PATH);

function usage() {
  process.stderr.write('Usage:\n');
  process.stderr.write('  check-suppression.cjs check <email>\n');
  process.stderr.write('  check-suppression.cjs batch <file>\n');
  process.stderr.write('  check-suppression.cjs list\n');
  process.exit(2);
}

function cmdCheck(email) {
  const result = list.guardSend(email);
  if (result.allowed) {
    process.stdout.write(`ALLOW ${result.email}\n`);
    process.exit(0);
  } else {
    process.stdout.write(`BLOCK ${result.email} reason=${result.reason} suppressedAt=${result.suppressedAt}\n`);
    process.exit(1);
  }
}

function cmdBatch(file) {
  let emails;
  try {
    emails = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    process.stderr.write(`Error reading file: ${err.message}\n`);
    process.exit(2);
  }

  const { allowed, blocked } = list.filterImport(emails);

  for (const email of allowed) {
    process.stdout.write(`ALLOW ${email}\n`);
  }
  for (const entry of blocked) {
    process.stdout.write(`BLOCK ${entry.email} reason=${entry.reason}\n`);
  }

  process.stdout.write(`\nSummary: ${allowed.length} allowed, ${blocked.length} blocked, ${emails.length} total\n`);

  if (blocked.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

function cmdList() {
  const entries = list.list();
  process.stdout.write(`Global suppression list — ${entries.length} entries\n`);
  process.stdout.write(`Fingerprint: ${list.fingerprint()}\n`);
  process.stdout.write(`Store: ${STORE_PATH}\n\n`);
  for (const entry of entries) {
    process.stdout.write(`${entry.email}  suppressedAt=${entry.suppressedAt}  source=${entry.source}\n`);
  }
  process.exit(0);
}

const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'check':
    if (!arg) usage();
    cmdCheck(arg);
    break;
  case 'batch':
    if (!arg) usage();
    cmdBatch(arg);
    break;
  case 'list':
    cmdList();
    break;
  default:
    usage();
}
