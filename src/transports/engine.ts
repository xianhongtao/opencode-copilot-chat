import type * as vscode from "vscode";
import {
  buildOpenCodeRequestError,
  formatDuration,
  formatRateLimitSummary,
  OpenCodeRequestError,
  readRateLimitInfo,
  truncateForLog,
} from "../errors";
import {
  analyzeHttp400ForRetry,
  isTransientServerError,
  TRANSIENT_5XX_MAX_RETRIES,
  TRANSIENT_5XX_RETRY_BASE_MS,
  TRANSIENT_5XX_RETRY_JITTER_MS,
} from "../retry";
import { createUsageDataParts } from "../chatParts";
import {
  clearContextWindowRequest,
  reportUsageToContextWindowForRequest,
  setContextWindowOutputBufferForRequest,
} from "../contextWindowHookBridge";
import { formatUsageLogLine } from "../usage/usage";
import { getErrorMessage, sleepWithCancellation } from "../utils";
import { parseServerSentEvent } from "./sse";
import { reportProgressPart, type RequestUsageSummary, type StreamOpenCodeResponseOptions } from "./streamParts";
import type { TransportRequestSummary } from "../core/transport";
import { updateRequestUsageSummary } from "./extract";

/**
 * Core streaming engine shared by every transport: performs the HTTP POST
 * (with HTTP-400 body patching and transient-5xx backoff retries), parses the
 * SSE stream, routes each event through the injected extractor, and emits a
 * per-request `TransportRequestSummary` on completion.
 */
export async function streamOpenCodeResponse(options: StreamOpenCodeResponseOptions): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const localRequestId = options.requestHeaders["x-opencode-request"];
  let firstByteAt: number | undefined;
  const usageSummary: RequestUsageSummary = {};
  let abortReason: "request-timeout" | "stream-idle-timeout" | "cancelled" | undefined;
  let responseStatus: number | undefined;
  let responseContentType: string | undefined;
  let emittedSummary = false;
  const abort = (reason: typeof abortReason) => {
    abortReason ??= reason;
    controller.abort();
  };
  const cancellation = options.token.onCancellationRequested(() => {
    abort("cancelled");
  });
  const requestTimeout = setTimeout(() => {
    abort("request-timeout");
  }, options.requestTimeoutMs);
  let streamIdleTimeout: ReturnType<typeof setTimeout> | undefined;
  const resetStreamIdleTimeout = () => {
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    streamIdleTimeout = setTimeout(() => {
      abort("stream-idle-timeout");
    }, options.streamIdleTimeoutMs);
  };
  const emitSummary = (totalBytes: number, totalEvents: number, extra?: Partial<TransportRequestSummary>) => {
    if (emittedSummary) {
      return;
    }
    emittedSummary = true;
    const summary: TransportRequestSummary = {
      providerDisplayName: options.providerDisplayName,
      modelId: options.modelId,
      url: options.url,
      requestId: options.requestHeaders["x-opencode-request"],
      sessionId: options.requestHeaders["x-opencode-session"],
      status: responseStatus,
      contentType: responseContentType,
      payloadBytes:
        typeof options.body === "string" ? options.body.length : new TextEncoder().encode(JSON.stringify(options.body)).byteLength,
      totalBytes,
      totalEvents,
      durationMs: Date.now() - startedAt,
      ...(firstByteAt === undefined ? {} : { ttfbMs: firstByteAt - startedAt }),
      ...(usageSummary.promptTokens === undefined ? {} : { promptTokens: usageSummary.promptTokens }),
      ...(usageSummary.completionTokens === undefined ? {} : { completionTokens: usageSummary.completionTokens }),
      ...(usageSummary.totalTokens === undefined ? {} : { totalTokens: usageSummary.totalTokens }),
      ...(usageSummary.cachedTokens === undefined ? {} : { cachedTokens: usageSummary.cachedTokens }),
      ...(usageSummary.finishReason === undefined ? {} : { finishReason: usageSummary.finishReason }),
      ...extra,
    };

    // Let the caller enrich the summary (e.g. add copilotCredits) before
    // we create the usage data parts, so VS Code session cost works.
    options.onTransportSummary?.(summary);

    options.output?.appendLine(
      `[response-summary] status=${String(summary.status ?? "n/a")} durationMs=${String(summary.durationMs)} ttfbMs=${String(summary.ttfbMs ?? "n/a")} promptTokens=${String(summary.promptTokens ?? "n/a")} completionTokens=${String(summary.completionTokens ?? "n/a")} totalTokens=${String(summary.totalTokens ?? "n/a")} cachedTokens=${String(summary.cachedTokens ?? "n/a")} finishReason=${summary.finishReason ?? "<unknown>"} totalBytes=${String(summary.totalBytes)} totalEvents=${String(summary.totalEvents)}`,
    );
    const usageLog = formatUsageLogLine({
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      totalTokens: summary.totalTokens,
      cachedTokens: summary.cachedTokens,
      finishReason: summary.finishReason,
    });
    if (usageLog) {
      options.output?.appendLine(`[usage] ${usageLog}`);
    }

    if (localRequestId) {
      reportUsageToContextWindowForRequest(localRequestId, {
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        cachedTokens: summary.cachedTokens,
        finishReason: summary.finishReason,
      });
    }

    const usageParts =
      summary.errorMessage || summary.abortedReason
        ? []
        : createUsageDataParts({
            promptTokens: summary.promptTokens,
            completionTokens: summary.completionTokens,
            totalTokens: summary.totalTokens,
            cachedTokens: summary.cachedTokens,
            finishReason: summary.finishReason,
            copilotCredits: summary.copilotCredits,
          });
    for (const usagePart of usageParts) {
      reportProgressPart(localRequestId, options.progress, usagePart);
    }
  };

  try {
    if (localRequestId && options.contextWindowOutputBuffer !== undefined) {
      setContextWindowOutputBufferForRequest(localRequestId, options.contextWindowOutputBuffer);
    }

    const rawPayload = JSON.stringify(options.body);

    // Log request for debugging latency.
    options.output?.appendLine(
      `[request] url=${options.url} payloadBytes=${String(rawPayload.length)} requestTimeoutMs=${String(options.requestTimeoutMs)} streamIdleTimeoutMs=${String(options.streamIdleTimeoutMs)}`,
    );

    // ------------------------------------------------------------------
    // NOTE: We do NOT gzip-compress the payload.  The OpenCode proxy
    // does not support Content-Encoding: gzip and returns HTTP 500.
    // ------------------------------------------------------------------
    let payload = rawPayload;
    const fetchHeaders: Record<string, string> = {
      ...(options.authHeaders ?? { Authorization: `Bearer ${options.apiKey}` }),
      "Content-Type": "application/json",
      ...options.requestHeaders,
    };
    const fetchWithBody = (body: string) =>
      fetch(options.url, {
        method: "POST",
        headers: fetchHeaders,
        body,
        signal: controller.signal,
      });

    let response = await fetchWithBody(payload);

    // --- Runtime retry for recoverable HTTP 400 errors ---
    // If the upstream rejects a parameter or reports an exact context overflow,
    // patch the body and retry once. This handles tokenizer differences, stale
    // models.dev metadata, and provider API changes without a hard user failure.
    let consumedErrorBody: string | undefined;
    if (response.status === 400) {
      const errorDetail = await response.text();
      consumedErrorBody = errorDetail;
      options.output?.appendLine(`[http-error-body] ${errorDetail.trim() ? truncateForLog(errorDetail) : "<empty>"}`);
      const parsedBody = JSON.parse(rawPayload) as Record<string, unknown>;
      const patch = analyzeHttp400ForRetry(errorDetail, parsedBody);
      if (patch) {
        options.output?.appendLine(`[retry] HTTP 400 recoverable: ${patch.reason}. Retrying with patched body…`);
        payload = JSON.stringify(patch.body);
        response = await fetchWithBody(payload);
        options.output?.appendLine(`[retry] Response after patch: ${String(response.status)} ${response.statusText}`);
        // If retry also returned 400, consume its body so the normal error
        // handler below doesn't try to re-read (the stream is already consumed).
        if (!response.ok && response.status === 400) {
          consumedErrorBody = await response.text();
        } else {
          // The patched retry produced a fresh (non-consumed) body, so any
          // stored 400 detail no longer matches the current response.
          consumedErrorBody = undefined;
        }
      }
    }

    // --- Transient 5xx retry (gateway/router capacity) ---
    // Retry a small number of times with exponential backoff (plus jitter)
    // when the gateway is momentarily unavailable (502/503/504, or 5xx body
    // that names Router.Unavailable). Cancellation aborts the wait immediately.
    let attempt = 0;
    while (attempt < TRANSIENT_5XX_MAX_RETRIES && isTransientServerError(response.status, consumedErrorBody ?? "")) {
      attempt += 1;
      // Jitter spreads concurrent retries so they don't pile on the gateway
      // at the same timestamp.
      const backoffMs = Math.round(TRANSIENT_5XX_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * TRANSIENT_5XX_RETRY_JITTER_MS);
      options.output?.appendLine(
        `[retry] transient ${String(response.status)} (attempt ${String(attempt)}/${String(TRANSIENT_5XX_MAX_RETRIES)}); retrying in ${String(backoffMs)}ms…`,
      );
      await sleepWithCancellation(backoffMs, options.token);
      if (options.token.isCancellationRequested) {
        break;
      }
      response = await fetchWithBody(payload);
      // A fresh response may carry a new error body; drop stale 400 detail.
      consumedErrorBody = undefined;
    }

    responseStatus = response.status;
    responseContentType = response.headers.get("content-type") ?? "";
    options.output?.appendLine(`[http] ${String(response.status)} ${response.statusText} content-type=${responseContentType || "<none>"}`);
    const rateLimitSummary = formatRateLimitSummary(readRateLimitInfo(response.headers));
    if (rateLimitSummary) {
      options.output?.appendLine(`[rate-limit] ${rateLimitSummary}`);
    }

    if (!response.ok) {
      // Use already-consumed body if available (from retry logic above),
      // otherwise read from the response stream.
      const detail = consumedErrorBody ?? (await response.text());
      options.output?.appendLine(`[http-error-body] ${detail.trim() ? truncateForLog(detail) : "<empty>"}`);
      const capacityHint =
        options.capacityLimitedModelNotes?.[options.modelId] && response.status >= 500
          ? ` — ${options.capacityLimitedModelNotes[options.modelId]}`
          : "";
      const requestError = buildOpenCodeRequestError(
        options.providerDisplayName,
        response,
        detail,
        options.modelId,
        payload.length,
        capacityHint,
      );
      emitSummary(new TextEncoder().encode(detail).byteLength, 0, {
        errorMessage: requestError.message,
        rateLimitSummary,
      });
      throw requestError;
    }

    if (!response.body || !responseContentType.includes("text/event-stream")) {
      const raw = await response.text();
      firstByteAt ??= Date.now();
      options.output?.appendLine(`[non-stream-body] ${truncateForLog(raw)}`);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      if (data !== undefined) {
        updateRequestUsageSummary(usageSummary, data);
        for (const part of options.extractFullParts(data)) {
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
      emitSummary(new TextEncoder().encode(raw).byteLength, data === undefined ? 0 : 1, {
        rateLimitSummary,
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let totalEvents = 0;
    // Diagnostic: collect raw SSE data when response is empty to identify
    // format mismatches between gateway output and our extractor (issue #93).
    const rawSseData: unknown[] = [];
    let extractedPartCount = 0;
    resetStreamIdleTimeout();

    while (!options.token.isCancellationRequested) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      resetStreamIdleTimeout();

      totalBytes += value.byteLength;
      if (firstByteAt === undefined && value.byteLength > 0) {
        firstByteAt = Date.now();
      }
      const chunk = decoder.decode(value, { stream: true });
      if (options.debugReasoning && options.output && chunk) {
        options.output.appendLine(`[sse-raw bytes=${String(value.byteLength)}] ${truncateForLog(chunk)}`);
      }
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        totalEvents += 1;
        if (options.debugReasoning && options.output && event.trim()) {
          options.output.appendLine(`[sse] ${truncateForLog(event)}`);
        }
        for (const part of parseServerSentEvent(event, options.extractStreamParts, (data) => {
          updateRequestUsageSummary(usageSummary, data);
          rawSseData.push(data);
        })) {
          extractedPartCount += 1;
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
    }

    if (buffer.trim()) {
      if (options.debugReasoning && options.output) {
        options.output.appendLine(`[sse-tail] ${truncateForLog(buffer)}`);
      }
      for (const part of parseServerSentEvent(buffer, options.extractStreamParts, (data) => {
        updateRequestUsageSummary(usageSummary, data);
        rawSseData.push(data);
      })) {
        extractedPartCount += 1;
        reportProgressPart(localRequestId, options.progress, part);
      }
    }

    if (options.debugReasoning && options.output) {
      options.output.appendLine(
        `[sse-stats] totalBytes=${String(totalBytes)} totalEvents=${String(totalEvents)} bufferTailLen=${String(buffer.length)}`,
      );
    }

    // Diagnostic: when the gateway reported completion tokens but our
    // extractor found nothing, dump raw SSE data to identify format mismatches.
    // This helps diagnose issues like #93 where the model generates tokens
    // but the response content is in an unrecognized format.
    if (usageSummary.completionTokens && usageSummary.completionTokens > 0 && extractedPartCount === 0 && rawSseData.length > 0) {
      options.output?.appendLine(
        `[diag-empty-response] model=${options.modelId} completionTokens=${String(usageSummary.completionTokens)} totalEvents=${String(totalEvents)} rawSseDataCount=${String(rawSseData.length)}`,
      );
      for (let i = 0; i < rawSseData.length; i++) {
        options.output?.appendLine(`[diag-sse-event-${String(i)}] ${truncateForLog(JSON.stringify(rawSseData[i]))}`);
      }
    }

    emitSummary(totalBytes, totalEvents, { rateLimitSummary });
  } catch (error) {
    if (abortReason === "cancelled") {
      emitSummary(0, 0, {
        abortedReason: "cancelled",
        errorMessage: "request cancelled",
      });
      return;
    }
    if (abortReason === "request-timeout") {
      const requestError = new OpenCodeRequestError(
        `${options.providerDisplayName} request timed out after ${formatDuration(options.requestTimeoutMs)}.`,
        `${options.providerDisplayName} did not start or finish the request within ${formatDuration(options.requestTimeoutMs)}. Try again later or reduce the request size.`,
      );
      emitSummary(0, 0, {
        abortedReason: "request-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    if (abortReason === "stream-idle-timeout") {
      const requestError = new OpenCodeRequestError(
        `${options.providerDisplayName} stream stalled for ${formatDuration(options.streamIdleTimeoutMs)} without new data.`,
        `${options.providerDisplayName} stopped sending stream data for ${formatDuration(options.streamIdleTimeoutMs)}, so the request was cancelled to avoid leaving Copilot stuck.`,
      );
      emitSummary(0, 0, {
        abortedReason: "stream-idle-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    emitSummary(0, 0, {
      errorMessage: getErrorMessage(error),
    });
    throw error;
  } finally {
    clearTimeout(requestTimeout);
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    cancellation.dispose();
    if (localRequestId) {
      clearContextWindowRequest(localRequestId);
    }
  }
}

export function createReasoningDebugger(
  output: vscode.OutputChannel | undefined,
  enabled: boolean,
): ((reasoningContent: string) => void) | undefined {
  if (!enabled || !output) {
    return undefined;
  }

  return (reasoningContent) => {
    output.appendLine("[reasoning_content]");
    output.appendLine(reasoningContent);
    output.appendLine("[/reasoning_content]");
  };
}
