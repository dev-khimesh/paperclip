# CAN-SPAM Opt-Out + Global Suppression List

**Status:** Built and tested end-to-end (**89/89 checks pass**). Wired to the send path by K-20062.
**Date:** 2026-09-28. **Sends:** K-20051 (P2 send precondition). **Depends on:** P1 entity (K-19926), P3 sending domain (K-19858) — see §5.

This is the machinery that makes the `{OPT_OUT_URL}` in the K-247 Day-1 CAN-SPAM footer actually operate, per 15 U.S.C. §7704(4)(C)(iii). It is deliberately built **entity-independent**: the suppression logic does not depend on the legal name or the verified sending domain, so it is built and tested now and goes live by pointing the domain at it when P3 lands.

> **The Day-1 send is performed by an agent through a connection, not by a repo code path.** The
> decision, the evidence, and what it forces on this module's design are in
> [`DECISION-day1-send-path.md`](./DECISION-day1-send-path.md). Read it before changing the
> preflight: it is why the guard is a gate the send step *calls* rather than a hook inside a
> sender, and why `filterImport` is left alone.

---

## 1. The two preconditions, and what this delivers

### 1a. Monitored sending mailbox (reply-"STOP") — **NOT YET PUBLISHABLE**

> **The reply-"STOP" footer line is withheld from publication.** Do not add "Reply STOP to opt
> out" to the Day-1 footer until the unblock condition below is met. Promising a STOP mailbox
> we cannot receive is the exact failure class this issue exists to close: a control that
> cannot fire, advertised as if it can.

| Field | Value |
|---|---|
| **Mailbox address** | `stop@<sending-domain>` — the domain verified under P3 (K-19858). **Does not exist yet.** |
| **Owner (who reads it)** | **CMO** (agent `2060aec7-8b6c-4ab8-912e-e4c8b9813515`). |
| **Turnaround — enforcement** | **Immediate**, once a reply can be received. A recorded STOP is blocked from all sends on the very next preflight. |
| **Turnaround — human review** | < 24 hours, business days, once live. |
| **Escalation** | Unacknowledged STOP after 24h → CEO. Repeated or contested → Legal (K-20015). |

**What is built and tested:** the *processing* half. `parseStopReply()` classifies an inbound
reply body against the 16 CFR 316.5 keywords; `recordStopReply()` writes the sender address into
the same global store the preflight reads, preserving idempotency and the original
`suppressedAt`. A STOP and a web opt-out are honoured identically and immediately. Proven by
`test-e2e.cjs` §15.

**What is missing:** the *receiving* half. There is no inbound mail path in this repository
(verified: no inbound-email route, webhook, or IMAP/POP poller anywhere in `server/src`), and
one cannot exist until P3 lands a verified sending domain with a routable `stop@` mailbox.

**Unblock condition — all three, then the footer line may be published:**

1. P3 lands a sending domain with a live, routed `stop@<domain>` mailbox.
2. Something forwards that mailbox into `POST /stop` (human reading it, or inbound mail
   routing). Until then, a STOP reply is never seen by anything.
3. `parseStopReply()` is wired to that forwarder, or the CMO confirms the manual path in the
   send runbook and K-20015 re-verifies.

Until all three hold, the only published opt-out mechanism is the `{OPT_OUT_URL}` in §2, which
is fully implemented and tested.

### 1b. Global suppression list

A **single** store, shared across every campaign and every list the company holds. Not per-campaign. Built once.

- **Writable from the opt-out endpoint** — `POST /opt-out` and the `GET /opt-out?email=...` landing page both write to it, and `POST /stop` writes to it from a reply.
- **Global enforcement** — the import guard (`filterImport`) strips any suppressed address from *any* incoming list/campaign, and the send preflight (`preflight`) refuses to dispatch to a suppressed address. Both read the one store.
- **Cannot be re-imported** — enforced at import time, before an address reaches a send queue. Proven by test §4 below.
- **Idempotent + auditable** — re-suppressing preserves the original `suppressedAt` (the legally relevant first opt-out). Every entry records `source`, `campaign`, `reason`, `suppressedAt`.

---

## 2. Files

| File | Role |
|---|---|
| `suppression.cjs` | Core store. Pure logic, no framework. `SuppressionList` class + `resolveStorePath()`. |
| `preflight.cjs` | **The send gate.** `preflight()` (fail-closed dispatch check), `recordStopReply()`, `parseStopReply()`, append-only audit log. |
| `server.cjs` | HTTP origin: landing page (`GET /opt-out`), JSON API (`POST /opt-out`), **send preflight (`POST /send-preflight`)**, **STOP recording (`POST /stop`)**, read-only list view (`GET /suppression-list`), health (`GET /health`). Zero dependencies (node:http). |
| `check-suppression.cjs` | CLI the send agent calls: `preflight`, `stop`, `check`, `batch`, `list`. |
| `test-e2e.cjs` | End-to-end test, **89 checks**. Real HTTP, real on-disk store, isolated temp dir. |
| `DECISION-day1-send-path.md` | Which component performs the Day-1 send, and why. (K-20062 AC1.) |
| `suppression-list.json` | The live store. **Not committed** — it holds real opted-out addresses (personal data). `CAN_SPAM_STORE` points at it. |
| `send-audit.log` | Append-only record of every preflight and every STOP. **Not committed** (same reason). `CAN_SPAM_AUDIT_LOG` points at it. |

The store is shared between the opt-out origin and the send step by being **one file behind
one origin** (`resolveStorePath()`), not by being in version control. A fresh clone has no
store, and the preflight therefore **fails closed** (§3c) — which is the correct behaviour, not
a setup step to skip.

## 3. Send-time suppression check (D1 — required before every dispatch)

The Day-1 send is performed by an agent through a connection, not a code path, so the guard is a
**preflight the send step calls**, not a hook inside a sender. Full rationale in
[`DECISION-day1-send-path.md`](./DECISION-day1-send-path.md).

### 3a. Before dispatching any batch — required

```bash
node marketing/can-spam/check-suppression.cjs preflight <file-with-one-recipient-per-line> --campaign <name>
```

**Call this immediately before each dispatch, not once at the start of the batch.** The preflight
re-reads the store on every call, so a recipient who opts out while the batch is in flight is
excluded from the unsent remainder. This is the K-20062 defect scenario, and it is proven by
test §4 [13].

The same check over HTTP, against the same origin that serves `{OPT_OUT_URL}`:

```bash
curl -sX POST "$OPTOUT_ORIGIN/send-preflight" \
  -H 'Content-Type: application/json' \
  -d '{"campaign":"k247-day1","recipients":["a@x.com","b@x.com"]}'
```

### 3b. Exit codes — the send step must branch on these

| Code | Meaning | Send action |
|---|---|---|
| `0` | every recipient clear | send to `allowed` |
| `1` | at least one recipient blocked | **do not** send to anything in `blocked`; send the rest |
| `3` | store unreadable — status **cannot be proven** | **send nothing**; escalate |
| `2` | usage error | fix the invocation |

Code `3` is deliberately distinct from `1`. A suppressed address and an *unknown* address are
both "do not send", but only one of them is a broken control, and only one of them is Legal's
problem to hear about.

### 3c. The preflight fails closed. Read this before working on it

- An **unreadable or absent** store blocks every recipient with `store_unavailable` and exits
  `3`. It never returns an empty `allowed` list, because "I could not read the list" and "nobody
  is suppressed" are different facts and only one of them is safe to act on.
- An **unparseable** recipient is blocked with `invalid_recipient`. It is never silently
  dropped.
- This is a deliberate difference from `filterImport`, which *does* silently skip invalid
  addresses. That is correct for an import filter and wrong for a send gate, so the two are
  separate functions over the same store. `test-e2e.cjs` §12 asserts they agree on every shared
  decision.

### 3d. Single-address, init, and list utilities

```bash
node marketing/can-spam/check-suppression.cjs init             # create the store (operator action)
node marketing/can-spam/check-suppression.cjs check <email>   # one address
node marketing/can-spam/check-suppression.cjs list            # current list + fingerprint
node marketing/can-spam/check-suppression.cjs stop <email>    # record a STOP reply
```

`init` is a deliberate operator step, not something a send does. It refuses to overwrite an
existing store, and refuses outright if one exists but is unreadable — a lost list silently
replaced by an empty one would un-suppress every opted-out address in the company.

### 3e. The opt-out endpoint fails closed in the write direction too

If the store cannot be written, `POST /opt-out` returns **503** and the landing page does **not**
render "removed from all lists". Telling a recipient they have been removed and then emailing them
again is the worst outcome this control has available, so a write failure is surfaced, not
swallowed. Proven by `test-e2e.cjs` §18.

### 3f. Process requirement for the Day-1 send agent

1. **Before any send:** run `preflight` on the recipients about to be dispatched.
2. **If exit 1:** send only to `allowed`. Do not send to anything in `blocked`.
3. **If exit 3:** send nothing. Report to the owner; the suppression control is not working.
4. **After sending:** reconcile against `send-audit.log` — every dispatched address must appear
   in an `allowed` list from a preflight run. An address that was sent with no preflight record
   is a bypass and goes to Legal (K-20015).
5. **STOP replies:** record via `POST /stop` or `check-suppression.cjs stop <email>`, and report
   to the CMO. See §1a for why this is currently a manual step.

Step 4 is the compensating control for the one gap this design cannot close: while the send is
an agent action, nothing in the type system can force the preflight to be called. The audit log
is what makes a skipped preflight visible instead of silent. Adding step 4 to K-19858's
acceptance is tracked as a follow-up in the decision doc.

## 4. How to run

```bash
# end-to-end test (89 checks; isolated temp store, never touches the live list)
node marketing/can-spam/test-e2e.cjs

# start the origin (also the {OPT_OUT_URL} target)
node marketing/can-spam/server.cjs
#   landing page:  http://127.0.0.1:8787/opt-out?email=you@example.com
#   json api:      POST http://127.0.0.1:8787/opt-out  {"email":"you@example.com"}
#   send preflight:POST http://127.0.0.1:8787/send-preflight {"campaign":"...","recipients":[...]}
#   stop reply:    POST http://127.0.0.1:8787/stop  {"email":"...","body":"STOP"}
#   list view:     http://127.0.0.1:8787/suppression-list   (for Legal verification)
```

Config via env: `OPTOUT_PORT`, `OPTOUT_HOST`, `CAN_SPAM_STORE` (store path; `OPTOUT_STORE` still
honoured), `CAN_SPAM_AUDIT_LOG` (audit log path).

## 4a. Test evidence (2026-09-28)

`node marketing/can-spam/test-e2e.cjs` → **89 passed, 0 failed**, in CI on every PR touching
`marketing/can-spam/` (`.github/workflows/can-spam-suppression.yml`). Real HTTP, real on-disk
store, isolated temp dir. The checks that close K-20062:

| § | Proves |
|---|---|
| [10] | The preflight is reachable over HTTP **from the same origin that serves `{OPT_OUT_URL}`**, against the same store (identical fingerprint). |
| [11] | An address in the global store is **excluded from the send list**, and the exclusion is **logged with a reason** (`globally_suppressed` + `suppressedAt` + `source`) to the append-only audit log. |
| [12] | The preflight and `filterImport` agree on the same object and the same reason string. |
| [13] | **Opt-out recorded mid-batch** blocks the address on the next preflight, in-process and over HTTP (no stale read). This is the defect scenario. |
| [14] | The preflight **fails closed**: unreadable store → fatal, `allowed` empty, exit 3; absent store → same; unparseable recipient → `invalid_recipient`, not dropped. |
| [15] | A STOP reply is classified, recorded into the same store, blocks the next dispatch, is visible on the Legal list view, and is idempotent. |
| [16] | `/health` reports the one store path the origin is using. |
| [17] | `init` creates a store, is a no-op on an existing one, and a corrupted store still fails closed. |
| [18] | An opt-out that **cannot be written** returns 503 and is never confirmed to the recipient — no false "you have been removed". |

Original coverage still green: opt-out → global store, cross-campaign suppression, cannot be
re-imported, `guardSend` refuses, idempotent re-suppression preserving the original timestamp,
landing page writes through to disk, 422/400 on invalid input.

## 5. Activation (depends on P1 + P3)

The machinery is live-tested but **not yet fronted by a real domain**, because:

- **P1 (entity, K-19926):** no `legalName` / postal address yet, so the footer's entity lines and the mailbox hostname cannot be finalised. The company record name is `$100k`.
- **P3 (sending domain, K-19858):** no SPF/DKIM-verified domain yet, so `stop@<domain>` and the public `{OPT_OUT_URL}` do not resolve.

**Activation steps when P1+P3 land:**
0. On each machine that will run a send: `node marketing/can-spam/check-suppression.cjs init`, and point `CAN_SPAM_STORE` at shared, backed-up storage. Until a store exists the preflight exits 3 and certifies nobody — that is intended.
1. Point the verified domain (or a `/opt-out` path) at `server.cjs`.
2. Set `{OPT_OUT_URL}` in the K-247 footer to that origin.
3. Set the footer entity lines from the P1 company record.
4. Publish `stop@<verified-domain>` as the reply-to / reply-"STOP" mailbox — **only after the
   three unblock conditions in §1a**, and wire it to `POST /stop`.
5. Re-run `test-e2e.cjs` against the live store to confirm wiring.

**No emails have been sent. K-19858 remains frozen.** This issue makes the opt-out *operable*
and puts a real gate in front of the dispatch; it does not authorise a send.

