# CAN-SPAM Opt-Out + Global Suppression List

**Status:** Built and tested end-to-end (28/28 checks pass). **Date:** 2026-09-28.
**Sends:** K-20051 (P2 send precondition). **Depends on:** P1 entity (K-19926), P3 sending domain (K-19858) — see §5.

This is the machinery that makes the `{OPT_OUT_URL}` in the K-247 Day-1 CAN-SPAM footer actually operate, per 15 U.S.C. §7704(4)(C)(iii). It is deliberately built **entity-independent**: the suppression logic does not depend on the legal name or the verified sending domain, so it is built and tested now and goes live by pointing the domain at it when P3 lands.

---

## 1. The two preconditions, and what this delivers

### 1a. Monitored sending mailbox (reply-"STOP")

Reply-"STOP" is only a valid opt-out mechanism if a human reads the mailbox and acts on it. Defined here:

| Field | Value |
|---|---|
| **Mailbox address** | `stop@<sending-domain>` — the domain verified under P3 (K-19858 Resend connection). Activates when P3 lands; the address pattern is fixed now. |
| **Owner (who reads it)** | **CMO** (agent `2060aec7-8b6c-4ab8-912e-e4c8b9813515`). Named, accountable owner for list hygiene and STOP processing. |
| **Turnaround — enforcement** | **Immediate.** A STOP reply is processed into the global suppression list synchronously; the address is blocked from all sends the instant it is recorded. |
| **Turnaround — human review** | **< 24 hours, business days.** CMO reviews the mailbox daily (business days) and confirms each STOP was honoured. |
| **Escalation** | Unacknowledged STOP after 24h → CEO. Repeated or contested → Legal (K-20015). |

The mailbox feeds the **same global store** as the web endpoint (§2), so a STOP reply and a web opt-out are honoured identically and immediately.

### 1b. Global suppression list

A **single** store, shared across every campaign and every list the company holds. Not per-campaign. Built once.

- **Writable from the opt-out endpoint** — `POST /opt-out` and the `GET /opt-out?email=...` landing page both write to it.
- **Global enforcement** — the import guard (`filterImport`) strips any suppressed address from *any* incoming list/campaign, and the send guard (`guardSend`) refuses to dispatch to a suppressed address. Both read the one store.
- **Cannot be re-imported** — enforced at import time, before an address reaches a send queue. Proven by test §4 below.
- **Idempotent + auditable** — re-suppressing preserves the original `suppressedAt` (the legally relevant first opt-out). Every entry records `source`, `campaign`, `reason`, `suppressedAt`.

---

## 2. Files

| File | Role |
|---|---|
| `suppression.cjs` | Core store + guards. Pure logic, no I/O framework. `SuppressionList` class. |
| `server.cjs` | HTTP endpoint: landing page (`GET /opt-out`), JSON API (`POST /opt-out`), read-only list view (`GET /suppression-list`), health (`GET /health`). Zero dependencies (node:http). |
| `check-suppression.cjs` | CLI tool for the send agent to consult the suppression list before dispatch. |
| `test-e2e.cjs` | End-to-end test, 28 checks. Real HTTP requests against a real on-disk store. |
| `suppression-list.json` | The live store (created at runtime). **Single source of truth.** |

## 3. Send-time suppression check (D1 — required before every dispatch)

The Day-1 send is performed by an agent through a connection, not a code path. The agent **must** consult the global suppression list before every dispatch. This is a hard requirement, not a recommendation.

### 3a. Before sending to any address, run:

```bash
node marketing/can-spam/check-suppression.cjs check <email>
```

- Exit code `0` + `ALLOW` → address is clear, send may proceed.
- Exit code `1` + `BLOCK` → address is suppressed, **send must not proceed**.

### 3b. Before sending to a batch, run:

```bash
node marketing/can-spam/check-suppression.cjs batch <file-with-one-email-per-line>
```

- Exit code `0` → all addresses clear.
- Exit code `1` → at least one address is suppressed. The output lists which are blocked. **Do not send to any blocked address.**

### 3c. To view the current suppression list:

```bash
node marketing/can-spam/check-suppression.cjs list
```

### 3d. Process requirement for the Day-1 send agent:

1. **Before any send:** run `check-suppression.cjs batch` on the full recipient list.
2. **If any address is BLOCK:** remove it from the send list. Do not send to it.
3. **After sending:** if any recipient replies "STOP", run `check-suppression.cjs check <email>` to verify it was recorded, and report to CMO.
4. **Escalation:** if a suppressed address appears in a future list, the import guard (`filterImport`) blocks it automatically. Report any bypass attempt to Legal.

This requirement is tracked as K-20062.

## 4. How to run

```bash
# end-to-end test (uses an isolated temp store; never touches the live list)
node marketing/can-spam/test-e2e.cjs

# start the endpoint (live store at marketing/can-spam/suppression-list.json)
node marketing/can-spam/server.cjs
#   landing page:  http://127.0.0.1:8787/opt-out?email=you@example.com
#   json api:     POST http://127.0.0.1:8787/opt-out  {"email":"you@example.com"}
#   list view:    http://127.0.0.1:8787/suppression-list   (for Legal verification)
```

Config via env: `OPTOUT_PORT`, `OPTOUT_HOST`, `OPTOUT_STORE` (override store path).

## 5. Test evidence (2026-09-28)

`node marketing/can-spam/test-e2e.cjs` → **28 passed, 0 failed**. Real requests, real on-disk store, isolated temp dir. Highlights:

- Opt-out via JSON API → `ok:true, added:true`, timestamp recorded.
- Address present in the global list, `source: opt-out-endpoint`.
- `isSuppressed` true regardless of campaign scope → **global, not per-campaign**.
- `filterImport([suppressed, clean], 'day2-campaign')` → suppressed **blocked** (`reason: globally_suppressed`), clean **allowed** → **cannot be re-imported**.
- `guardSend(suppressed)` → `allowed:false`; `guardSend(clean)` → `allowed:true`.
- Re-suppression → `already:true`, original timestamp preserved, count stays 1 (no duplicate).
- Landing page (GET) writes through to disk; re-read from disk confirms.
- Invalid email → 422; missing email → 400.

## 6. Activation (depends on P1 + P3)

The machinery is live-tested but **not yet fronted by a real domain**, because:

- **P1 (entity, K-19926):** no `legalName` / postal address yet, so the footer's entity lines and the mailbox hostname cannot be finalised. The company record name is `$100k`.
- **P3 (sending domain, K-19858):** no SPF/DKIM-verified domain yet, so `stop@<domain>` and the public `{OPT_OUT_URL}` do not resolve.

**Activation steps when P1+P3 land:**
1. Point the verified domain (or a `/opt-out` path) at `server.cjs`.
2. Set `{OPT_OUT_URL}` in the K-247 footer to that origin.
3. Set the footer entity lines from the P1 company record.
4. Publish `stop@<verified-domain>` as the reply-to / reply-"STOP" mailbox.
5. Re-run `test-e2e.cjs` against the live store to confirm wiring.

**No emails have been sent. K-19858 remains frozen.** This issue makes the opt-out *operable*; it does not authorise a send.
