// ---------------------------------------------------------------------------
// ThinkTagFilter — streaming stripper for inline `<think>...</think>` tags
//
// Some models (notably MiniMax M-series) inline their chain-of-thought
// directly inside the `content` text field wrapped in `<think>` / `</think>`
// tags rather than using a dedicated `reasoning_content` field.  When this
// raw text is emitted to the VS Code chat UI the reasoning "leaks" into the
// visible response, making it unreadable.
//
// The filter processes text **as it arrives** (potentially split across many
// SSE chunks) and separates it into:
//   • `visibleText` — content outside think tags (emitted to chat)
//   • `thinkingText` — content inside think tags (accumulated as reasoning)
//
// Edge cases handled:
//   - `<think>` or `</think>` split across chunk boundaries
//   - Unclosed `<think>` at end of stream (flushed as thinking on `finish()`)
//   - Leading whitespace immediately after opening `<think>` is trimmed
// ---------------------------------------------------------------------------

const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";

export function shouldStripThinkTags(mode: "never" | "auto" | "always" | undefined, modelId: string): boolean {
  if (mode === "always") {
    return true;
  }
  if (mode === "never" || mode === undefined) {
    return false;
  }
  // "auto" — strip only for models known to inline thinking tags
  return /^minimax-m/i.test(modelId);
}

export function createThinkTagFilter(mode: "never" | "auto" | "always" | undefined, modelId: string): ThinkTagFilter | undefined {
  return shouldStripThinkTags(mode, modelId) ? new ThinkTagFilter() : undefined;
}

export class ThinkTagFilter {
  /** Partial text carried over from the previous chunk for boundary matching. */
  private carry = "";
  /** Whether we are currently inside a `<think>` block. */
  private insideThink = false;

  /**
   * Process an incoming text chunk.
   * Returns `{ visible, thinking }` where `visible` is safe to emit to the
   * chat and `thinking` should be accumulated as reasoning content.
   */
  process(chunk: string): { visible: string; thinking: string } {
    if (!chunk) {
      return { visible: "", thinking: "" };
    }

    // Prepend carry from the previous chunk so boundary tags can be detected
    // even when they are split across chunks.
    const buffer = this.carry + chunk;
    this.carry = "";

    let visible = "";
    let thinking = "";
    let pos = 0;
    const maxScan = Math.max(OPEN_THINK_TAG.length, CLOSE_THINK_TAG.length);

    while (pos < buffer.length) {
      if (this.insideThink) {
        // Look for closing </think>
        const closeIdx = buffer.indexOf(CLOSE_THINK_TAG, pos);
        if (closeIdx === -1) {
          // No closing tag found — consume the rest, but keep a tail for
          // boundary matching in the next chunk.
          const safeEnd = buffer.length - maxScan;
          if (safeEnd > pos) {
            thinking += buffer.slice(pos, safeEnd);
            this.carry = buffer.slice(safeEnd);
          } else {
            // Entire remaining buffer is shorter than max scan — carry it all
            this.carry = buffer.slice(pos);
          }
          break;
        }
        // Found closing tag
        thinking += buffer.slice(pos, closeIdx);
        pos = closeIdx + CLOSE_THINK_TAG.length;
        this.insideThink = false;
        // Skip a single leading whitespace after </think> for cleaner output
        if (pos < buffer.length && (buffer[pos] === "\n" || buffer[pos] === "\r")) {
          pos += 1;
          if (pos < buffer.length && buffer[pos] === "\n") {
            pos += 1;
          }
        }
      } else {
        // Look for opening <think>
        const openIdx = buffer.indexOf(OPEN_THINK_TAG, pos);
        if (openIdx === -1) {
          // No opening tag — emit visible text but keep a tail for boundary
          const safeEnd = buffer.length - maxScan;
          if (safeEnd > pos) {
            visible += buffer.slice(pos, safeEnd);
            this.carry = buffer.slice(safeEnd);
          } else {
            this.carry = buffer.slice(pos);
          }
          break;
        }
        // Found opening tag
        visible += buffer.slice(pos, openIdx);
        pos = openIdx + OPEN_THINK_TAG.length;
        this.insideThink = true;
        // Skip a single leading whitespace after <think>
        if (pos < buffer.length && (buffer[pos] === "\n" || buffer[pos] === "\r")) {
          pos += 1;
          if (pos < buffer.length && buffer[pos] === "\n") {
            pos += 1;
          }
        }
      }
    }

    return { visible, thinking };
  }

  /**
   * Call at end of stream to flush any remaining carry.
   * If we were inside an unclosed `<think>`, that content is treated as
   * thinking. Otherwise the remaining carry is visible text.
   */
  finish(): { visible: string; thinking: string } {
    const remaining = this.carry;
    this.carry = "";
    if (this.insideThink) {
      // Unclosed think tag at end of stream — treat as thinking
      this.insideThink = false;
      return { visible: "", thinking: remaining };
    }
    return { visible: remaining, thinking: "" };
  }
}
