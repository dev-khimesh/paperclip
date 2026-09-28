'use strict';

/**
 * Global CAN-SPAM suppression list — single source of truth.
 *
 * One store, shared across every campaign and every list the company holds.
 * Both opt-out channels (web endpoint + monitored STOP mailbox) write here,
 * so an opt-out honoured on one channel is honoured on all of them. An address
 * on this list cannot be re-imported into any campaign or list, and the send
 * guard refuses to dispatch to it.
 *
 * Persistence: a single JSON file. The list is keyed by normalised email for
 * O(1) lookup and idempotent re-suppression.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_STORE_PATH = path.join(__dirname, 'suppression-list.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The one place the store's location is decided.
 *
 * Both the opt-out origin (which serves {OPT_OUT_URL}) and the send preflight
 * resolve through here, so there is exactly one file behind exactly one reader
 * process. A store the send step cannot read is not a control.
 *
 * CAN_SPAM_STORE is canonical; OPTOUT_STORE is honoured for the existing
 * server/CLI entry points.
 */
function resolveStorePath(env = process.env) {
  return env.CAN_SPAM_STORE || env.OPTOUT_STORE || DEFAULT_STORE_PATH;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function newStore() {
  return {
    version: 1,
    description:
      'Global CAN-SPAM suppression list. Single source of truth across all campaigns and lists. Opt-outs recorded here cannot be re-imported.',
    entries: {},
  };
}

class SuppressionList {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.store = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.loadError = null;
        this.loadedFromDisk = true;
        return parsed;
      }
      this.loadError = new Error('unrecognised store shape');
      this.loadedFromDisk = true;
    } catch (err) {
      // Missing or unreadable store: start clean rather than crash. Callers that
      // must *prove* an address is clear (the send preflight) check loadError
      // and fail closed instead of reading an empty list as "nothing suppressed".
      this.loadError = err;
      this.loadedFromDisk = false;
    }
    return newStore();
  }

  /**
   * Re-read the store from disk. The send preflight calls this on every
   * invocation so an opt-out recorded mid-batch is observed by the next
   * dispatch decision, not only at batch start.
   */
  refresh() {
    this.store = this._load();
    return this;
  }

  /**
   * True when the backing file was read and parsed successfully. False means
   * "this list is empty because we could not read it" — never "nothing is
   * suppressed".
   */
  isReadable() {
    return this.loadError === null;
  }

  /**
   * The recorded opt-out for an address, or null. Lets a caller attach the
   * legally relevant metadata (suppressedAt, source) to a block decision
   * without re-deriving it.
   */
  entryFor(email) {
    const key = normalizeEmail(email);
    if (!key) return null;
    return this.store.entries[key] || null;
  }

  _persist() {
    // The store may be pointed at a path that does not exist yet (first
    // deployment, or CAN_SPAM_STORE moved). Create it rather than failing a
    // write — but never silently swallow a real write failure.
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmp, this.storePath);
  }

  /** Public write, for operator tooling that mutates the store directly. */
  persist() {
    this._persist();
    return this;
  }

  isSuppressed(email) {
    const key = normalizeEmail(email);
    if (!key) return false;
    return Object.prototype.hasOwnProperty.call(this.store.entries, key);
  }

  /**
   * Record an opt-out. Idempotent: re-suppressing an existing address is a
   * no-op that returns already=true and never overwrites the original
   * suppressedAt timestamp (the first opt-out is the legally relevant one).
   *
   * Fails closed in the write direction: if the store cannot be written the
   * call throws and the entry is rolled back, so a caller can never report an
   * opt-out as recorded when it was not. Telling a recipient "you have been
   * removed" and then emailing them again is the worst outcome available here.
   */
  suppress(email, meta = {}) {
    const key = normalizeEmail(email);
    if (!key) {
      return { ok: false, reason: 'invalid_email', email: String(email) };
    }
    const existing = this.store.entries[key];
    if (existing) {
      return { ok: true, added: false, already: true, entry: existing };
    }
    const entry = {
      email: key,
      suppressedAt: new Date().toISOString(),
      source: meta.source || 'unknown',
      campaign: meta.campaign || null,
      reason: meta.reason || 'opt-out',
    };
    this.store.entries[key] = entry;
    try {
      this._persist();
    } catch (err) {
      delete this.store.entries[key];
      throw err;
    }
    return { ok: true, added: true, already: false, entry };
  }

  list() {
    return Object.values(this.store.entries).sort((a, b) =>
      a.suppressedAt < b.suppressedAt ? -1 : 1
    );
  }

  count() {
    return Object.keys(this.store.entries).length;
  }

  /**
   * Import guard. Given a candidate list for a campaign, drop every address
   * that is on the global suppression list. This is what makes an opt-out
   * impossible to re-import: the filter runs at import time, before the
   * address ever reaches a send queue.
   */
  filterImport(emails, campaign = null) {
    const allowed = [];
    const blocked = [];
    for (const raw of emails || []) {
      const key = normalizeEmail(raw);
      if (!key) continue;
      if (this.isSuppressed(key)) {
        blocked.push({ email: key, campaign, reason: 'globally_suppressed' });
      } else {
        allowed.push(key);
      }
    }
    return { allowed, blocked };
  }

  /**
   * Send guard. Returns a result the dispatcher can branch on; the send path
   * must treat `allowed:false` as a hard stop.
   */
  guardSend(email, campaign = null) {
    const key = normalizeEmail(email);
    if (!key) return { allowed: false, reason: 'invalid_email', email: String(email) };
    const entry = this.store.entries[key];
    if (entry) {
      return { allowed: false, reason: 'globally_suppressed', email: key, suppressedAt: entry.suppressedAt, campaign };
    }
    return { allowed: true, email: key, campaign };
  }

  fingerprint() {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(this.store.entries));
    return hash.digest('hex').slice(0, 16);
  }
}

module.exports = { SuppressionList, normalizeEmail, resolveStorePath, newStore, DEFAULT_STORE_PATH };
