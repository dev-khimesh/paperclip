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
        return parsed;
      }
    } catch (_err) {
      // Missing or unreadable store: start clean rather than crash.
    }
    return newStore();
  }

  _persist() {
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmp, this.storePath);
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
    this._persist();
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

module.exports = { SuppressionList, normalizeEmail, DEFAULT_STORE_PATH };
