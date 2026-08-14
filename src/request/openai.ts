/**
 * OpenAI-family request body builders.
 *
 * Builds the wire payloads for the OpenAI-compatible chat-completions endpoint
 * and the Responses API endpoint.
 *
 * CONTRACT: pure functions only — `vscode` is used as a TYPE and for the
 * `LanguageModelChatToolMode` enum value only; no extension-host side effects.
 */
import * as vscode from "vscode";
import { buildResponsesRequestEnvelope, responsesInputItemsFromMessage } from "../responsesRequest";
import { thinkingProviderFor } from "../thinking";
import { sanitizeToolSchema } from "./schema";
import { messagesHaveImages } from "./shared";
import type { ResolvedModelMetadata } from "../metadata";
import type { ModelLimits } from "../modelLimits";
import type { ApiMessage, ApiSettings, OpenAiToolDefinition } from "./types";

export function buildChatCompletionsRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  metadata: ResolvedModelMetadata,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapOpenAiTools(options.tools);
  const thinkingPayload = thinkingProviderFor(modelId).buildPayload(settings.thinking, {
    hasImageInput: messagesHaveImages(messages),
    endpoint: "chat",
  });

  return {
    model: modelId,
    messages,
    // Only send temperature if the model supports it (not deprecated)
    ...(metadata.temperature !== false ? { temperature: settings.temperature } : {}),
    max_tokens: limits.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingPayload,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
  };
}

export function buildResponsesRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  metadata: ResolvedModelMetadata,
  limits: ModelLimits,
): Record<string, unknown> {
  const input = messages.flatMap((message) => responsesInputItemsFromMessage(message));
  const tools = mapResponsesTools(options.tools);
  const thinkingPayload = thinkingProviderFor(modelId).buildPayload(settings.thinking, {
    hasImageInput: messagesHaveImages(messages),
    endpoint: "responses",
  });

  return buildResponsesRequestEnvelope({
    model: modelId,
    input,
    maxOutputTokens: limits.maxOutputTokens,
    // Some models reject any non-default temperature value.
    ...(metadata.temperature === false ? {} : { temperature: settings.temperature }),
    thinkingPayload,
    tools,
    toolChoice: toolChoice(options.toolMode),
  });
}

function mapOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAiToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.inputSchema),
    },
  }));
}

function mapResponsesTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Record<string, unknown>[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
}

function toolChoice(mode: vscode.LanguageModelChatToolMode): "auto" | "required" {
  return mode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}
