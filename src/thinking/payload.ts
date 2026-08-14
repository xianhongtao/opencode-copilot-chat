/**
 * Payload-level thinking detection.
 *
 * CONTRACT: pure only — no `vscode` import, no side effects.
 */

/**
 * Whether a request body asks the model to think, through ANY channel the
 * extension emits: `reasoning_effort`, `budget_tokens`, `enable_thinking`,
 * or an Anthropic-style `thinking` block (`enabled` / `adaptive`).
 *
 * Used for diagnostics / logging. The DISPLAY decision (thinking part vs
 * visible text) is made by each provider's `treatReasoningAsContent`, not by
 * inferring intent from the body.
 */
export function bodyRequestsThinking(body: Record<string, unknown> | undefined): boolean {
  if (!body) return false;
  if (typeof body.reasoning_effort === "string") return true;
  if (typeof body.budget_tokens === "number") return true;
  if (body.enable_thinking === true) return true;
  if (body.thinking !== null && typeof body.thinking === "object") {
    const type = (body.thinking as Record<string, unknown>).type;
    return type === "enabled" || type === "adaptive";
  }
  return false;
}
