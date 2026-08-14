import type { LanguageModelResponsePart2, Progress } from "vscode";
import type { UsageSnapshot } from "./usage/usage";
import { getErrorMessage } from "./utils";

type ContextWindowHookModule = typeof import("./contextWindowHook.js");

let loadedContextWindowHookModule: ContextWindowHookModule | null = null;
let loadingContextWindowHookModule: Promise<ContextWindowHookModule | null> | undefined;

let reportUsageImpl = (_localRequestId: string, _usage: UsageSnapshot): boolean => false;
let reportProgressImpl = (
  _localRequestId: string,
  progress: Progress<LanguageModelResponsePart2>,
  part: LanguageModelResponsePart2,
): void => {
  progress.report(part);
};
let clearRequestImpl = (_localRequestId: string): void => {
  // No-op: request tracking is cleared by the hook module when it is active.
};
let setOutputBufferImpl = (_localRequestId: string, _outputBuffer: number): void => {
  // No-op: output-buffer tracking is handled by the hook module when it is active.
};

function installNoopImplementations(): void {
  reportUsageImpl = (_localRequestId: string, _usage: UsageSnapshot): boolean => false;
  reportProgressImpl = (
    _localRequestId: string,
    progress: Progress<LanguageModelResponsePart2>,
    part: LanguageModelResponsePart2,
  ): void => {
    progress.report(part);
  };
  clearRequestImpl = (_localRequestId: string): void => {
    // No-op: request tracking is cleared by the hook module when it is active.
  };
  setOutputBufferImpl = (_localRequestId: string, _outputBuffer: number): void => {
    // No-op: output-buffer tracking is handled by the hook module when it is active.
  };
}

function installHookImplementations(hookModule: ContextWindowHookModule): void {
  reportUsageImpl = hookModule.reportUsageToContextWindowForRequest;
  reportProgressImpl = hookModule.reportProgressWithContextWindowRequest;
  clearRequestImpl = hookModule.clearContextWindowRequest;
  setOutputBufferImpl = hookModule.setContextWindowOutputBufferForRequest;
}

async function loadContextWindowHookModule(logDiagnostic?: (message: string) => void): Promise<ContextWindowHookModule | null> {
  if (loadedContextWindowHookModule) {
    return loadedContextWindowHookModule;
  }

  if (!loadingContextWindowHookModule) {
    loadingContextWindowHookModule = import("./contextWindowHook.js")
      .then((hookModule) => {
        loadedContextWindowHookModule = hookModule;
        return hookModule;
      })
      .catch((error: unknown) => {
        logDiagnostic?.(`contextWindowHook: failed to import hook module — ${getErrorMessage(error)}`);
        loadingContextWindowHookModule = undefined;
        return null;
      });
  }

  const hookModule = await loadingContextWindowHookModule;
  loadingContextWindowHookModule = undefined;
  return hookModule;
}

export function reportUsageToContextWindowForRequest(localRequestId: string, usage: UsageSnapshot): boolean {
  return reportUsageImpl(localRequestId, usage);
}

export function reportProgressWithContextWindowRequest(
  localRequestId: string,
  progress: Progress<LanguageModelResponsePart2>,
  part: LanguageModelResponsePart2,
): void {
  reportProgressImpl(localRequestId, progress, part);
}

export function clearContextWindowRequest(localRequestId: string): void {
  clearRequestImpl(localRequestId);
}

export function setContextWindowOutputBufferForRequest(localRequestId: string, outputBuffer: number): void {
  setOutputBufferImpl(localRequestId, outputBuffer);
}

export async function initializeContextWindowHookBridge(logDiagnostic?: (message: string) => void): Promise<boolean> {
  const hookModule = await loadContextWindowHookModule(logDiagnostic);
  if (!hookModule) {
    installNoopImplementations();
    logDiagnostic?.("contextWindowHook: bridge staying in no-op mode (module not available)");
    return false;
  }

  const success = await hookModule.initializeContextWindowHook(logDiagnostic);
  if (success) {
    installHookImplementations(hookModule);
    logDiagnostic?.("contextWindowHook: bridge active — usage will be injected into the Copilot Chat footer");
  } else {
    installNoopImplementations();
    logDiagnostic?.("contextWindowHook: bridge staying in no-op mode (proxy capture failed or config changed)");
  }

  return success;
}

export function disposeContextWindowHookBridge(): boolean {
  installNoopImplementations();

  if (!loadedContextWindowHookModule) {
    return false;
  }

  return loadedContextWindowHookModule.disposeContextWindowHook();
}

installNoopImplementations();
