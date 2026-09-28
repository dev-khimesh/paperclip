/**
 * Anti-early-stop instructions for unattended agentic runs.
 *
 * An unattended harness treats `stop_reason: "end_turn"` as "the task is done". A
 * model that ends a turn with a status update instead of a tool call therefore
 * silently ends the work. Anthropic's "Prompting Claude Opus 5.5 -> Unattended
 * agentic runs" documents the failure and the remedy: a standing system-prompt
 * addition placed at the END of the system prompt from the first request of the
 * session. Adding it mid-session rewrites the `system` prompt and invalidates
 * earlier thinking blocks, so it has to be baked into the materialized bundle
 * rather than injected per-turn.
 *
 * This module is the single source of truth for that block. It is appended at
 * bundle-assembly time (see `default-agent-instructions.ts`,
 * `onboarding-first-task-assets.ts`, and `validateBuiltInAgentDefinitions`) so it
 * always lands last in the entry file, never drifts between templates, and is
 * picked up automatically by templates added later.
 *
 * The runtime half of this guard already exists and is what makes the promise in
 * the text honest: `classifyRunLiveness` reports a text-only summary as
 * `plan_only` rather than completion, and `decideRunLivenessContinuation` re-runs
 * the agent a bounded number of times (`DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS`).
 * See `services/recovery/run-liveness-continuations.ts`.
 */

/** Heading doubles as the idempotency marker for {@link appendAntiEarlyStopInstructions}. */
export const ANTI_EARLY_STOP_HEADING = "## Do not stop early";

/**
 * Keep this short. It is prepended to every agent's system prompt on every
 * session, so every line is paid for in tokens on every task.
 */
export const ANTI_EARLY_STOP_INSTRUCTIONS = [
  ANTI_EARLY_STOP_HEADING,
  "",
  "You are running unattended. Nothing is watching this turn, so a status update nobody reads ends the work.",
  "",
  "- A turn that ends with only text is a report, not completion.",
  "- Put a status note in the *same* message as your next tool call. If a message announces what you will do next, that message must also make the call.",
  "- Delete any closing offer to continue \"unless you'd prefer otherwise\", any list of decisions for the user, and any \"this is a good point to report back\". They stall a run that nobody will answer.",
  "- Keep a checklist of the task's parts and work it down. While the checklist has open items, a text-only reply is treated as a premature stop: Paperclip records it as `plan_only` and re-runs you a bounded number of times, so ending the turn early is wasted work rather than a quiet exit.",
  "",
  "This never overrides confirmation. Risky, destructive, or irreversible actions still need their `request_confirmation` or explicit approval. It also does not apply while a human is present to answer: if you are waiting on an open `ask_user_questions` or `request_confirmation`, on a real blocker, or on a dependency, stop, set the disposition, and wait.",
  "",
  "If you genuinely cannot continue, say what is missing and set the disposition. Do not pad the turn to avoid stopping.",
].join("\n");

/**
 * Append the block to a template body unless it is already present.
 *
 * Idempotent because bundles are re-assembled on reconcile and re-materialized on
 * stock updates, and because an operator may have hand-copied the block into their
 * own AGENTS.md. Double-appending would push duplicated text into the system prompt
 * and break the stock-hash drift check in `built-in-agents.ts`.
 */
export function appendAntiEarlyStopInstructions(content: string): string {
  if (content.includes(ANTI_EARLY_STOP_HEADING)) return content;
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}\n\n${ANTI_EARLY_STOP_INSTRUCTIONS}\n`;
}
