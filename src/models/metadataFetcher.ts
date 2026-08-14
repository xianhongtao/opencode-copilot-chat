import * as vscode from "vscode";
import { MODEL_METADATA_CACHE_KEY, MODEL_METADATA_FETCH_TIMEOUT_MS, MODELS_DEV_API_URL } from "../config";
import {
  bundledModelMetadataSnapshot,
  isFreshModelMetadata,
  normalizeModelsDevSnapshot,
  type CachedModelMetadataSnapshot,
  type ModelsDevResponse,
} from "./metadata";
import { getErrorMessage } from "../utils";
import { GO_VENDOR, ZEN_VENDOR } from "../providerTypes";

/**
 * In-memory models.dev metadata cache shared by the provider domain and the
 * usage dashboard (cost resolver). Owned here so the fetch orchestration and
 * the state never drift apart.
 */
let modelMetadataSnapshot: CachedModelMetadataSnapshot | undefined;
let modelMetadataRefreshPromise: Promise<CachedModelMetadataSnapshot> | undefined;

export function getModelMetadataSnapshot(): CachedModelMetadataSnapshot | undefined {
  return modelMetadataSnapshot;
}

export function setModelMetadataSnapshot(snapshot: CachedModelMetadataSnapshot | undefined): void {
  modelMetadataSnapshot = snapshot;
}

export function setModelMetadataRefreshPromise(promise: Promise<CachedModelMetadataSnapshot> | undefined): void {
  modelMetadataRefreshPromise = promise;
}

export async function clearOpenCodeModelMetadataCache(context: vscode.ExtensionContext): Promise<void> {
  modelMetadataSnapshot = undefined;
  modelMetadataRefreshPromise = undefined;
  await context.globalState.update(MODEL_METADATA_CACHE_KEY, undefined);
}

export async function getOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  const cached = modelMetadataSnapshot ?? context.globalState.get<CachedModelMetadataSnapshot>(MODEL_METADATA_CACHE_KEY);
  if (cached) {
    modelMetadataSnapshot = cached;
    if (isFreshModelMetadata(cached)) {
      return cached;
    }
    void refreshOpenCodeModelMetadata(context, output);
    return cached;
  }

  return refreshOpenCodeModelMetadata(context, output);
}

export async function refreshOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  if (modelMetadataRefreshPromise) {
    return modelMetadataRefreshPromise;
  }

  modelMetadataRefreshPromise = (async () => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`models.dev request failed (${String(response.status)}): ${response.statusText}`);
    }

    const data = (await response.json()) as ModelsDevResponse;
    const snapshot = normalizeModelsDevSnapshot(data);
    modelMetadataSnapshot = snapshot;
    await context.globalState.update(MODEL_METADATA_CACHE_KEY, snapshot);
    output?.appendLine(
      `[metadata] refreshed models.dev cache go=${Object.keys(snapshot.providers[GO_VENDOR] ?? {}).length} zen=${Object.keys(snapshot.providers[ZEN_VENDOR] ?? {}).length}`,
    );
    return snapshot;
  })()
    .catch((error: unknown) => {
      const cached = modelMetadataSnapshot ?? context.globalState.get<CachedModelMetadataSnapshot>(MODEL_METADATA_CACHE_KEY);
      if (cached) {
        const message = getErrorMessage(error);
        output?.appendLine(`[metadata] refresh failed, using cached snapshot: ${message}`);
        modelMetadataSnapshot = cached;
        return cached;
      }

      const message = getErrorMessage(error);
      const fallback = bundledModelMetadataSnapshot();
      output?.appendLine(`[metadata] refresh failed, using bundled snapshot: ${message}`);
      modelMetadataSnapshot = fallback;
      return fallback;
    })
    .finally(() => {
      modelMetadataRefreshPromise = undefined;
    });

  return modelMetadataRefreshPromise;
}
