import * as vscode from "vscode";
import { DEFAULT_VISION_PROXY_PROMPT, VISION_PROXY_MODEL_ID_KEY, VISION_PROXY_PROMPT_KEY } from "../config";
import { VISION_CAPABLE_MODELS } from "../models/metadata";
import { getModelMetadataSnapshot } from "../models/metadataFetcher";
import { GO_VENDOR, ZEN_VENDOR } from "../providerTypes";
import { dataPartToBase64 } from "./messages";
import { resolveRawModelId, resolveVendorFromId } from "./settings";
import { imageDescriptionKey, lookupImageDescriptions, storeImageDescriptions } from "../visionProxyCache";

/** Result of a vision-proxy pass: per-message descriptions plus cache stats. */
export interface VisionProxyResult {
  /** Original message index → text description (only for messages with images). */
  descriptions: ReadonlyMap<number, string>;
  /** Messages whose images were already cached — no vision model request was made. */
  cacheHits: number;
  /** Messages that required a new vision-model request. */
  cacheMisses: number;
}

/**
 * Collect the parts of a single message that the vision proxy should see:
 * image parts plus text parts, dropping tool parts.
 */
function collectRequestParts(msg: vscode.LanguageModelChatRequestMessage): (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] {
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      parts.push(part);
    } else if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part);
    } else if (typeof part === "object" && part !== null && "value" in part) {
      parts.push(new vscode.LanguageModelTextPart(String(part.value)));
    }
  }
  return parts;
}

/**
 * Build a vision-model request: keep image and text parts from every message
 * (dropping tool parts), then append the vision prompt. Used both for the
 * per-message path (single message) and the whole-conversation path (all
 * messages) when `opencodego.visionProxyWholeConversation` is enabled.
 */
function buildVisionRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  visionPrompt: string,
): vscode.LanguageModelChatMessage[] {
  const requestMessages: vscode.LanguageModelChatMessage[] = [];
  for (const msg of messages) {
    const parts = collectRequestParts(msg);
    if (parts.length > 0) {
      requestMessages.push(
        new vscode.LanguageModelChatMessage(
          msg.role === vscode.LanguageModelChatMessageRole.Assistant
            ? vscode.LanguageModelChatMessageRole.Assistant
            : vscode.LanguageModelChatMessageRole.User,
          parts,
        ),
      );
    }
  }
  // Append the vision prompt
  if (visionPrompt) {
    requestMessages.push(vscode.LanguageModelChatMessage.User(visionPrompt));
  }
  return requestMessages;
}

/**
 * Vision proxy: relay image messages through a vision-capable Copilot model
 * and return the text description. This lets text-only models "see" images
 * transparently (issue #74).
 *
 * By default (`describeWholeConversation` false), descriptions are cached per
 * image (`imageDescriptionCache`). A message whose images are ALL already
 * cached is reused without contacting the vision model; only messages that
 * contain at least one new image trigger a `sendRequest()` - for that single
 * message + prompt - and the result is stored in the cache for future turns.
 *
 * When `describeWholeConversation` is true (setting
 * `opencodego.visionProxyWholeConversation`), the proxy sends ONE request over
 * the whole conversation so descriptions keep full context; the combined
 * description is still stored under every image hash.
 */
export async function proxyVision(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  visionModelId: string,
  visionPrompt: string,
  describeWholeConversation: boolean,
  token: vscode.CancellationToken,
): Promise<VisionProxyResult> {
  const descriptions = new Map<number, string>();
  let cacheHits = 0;
  let cacheMisses = 0;

  // Find the vision model lazily — only when a message actually needs a new
  // description. When every image is already cached we never call
  // `vscode.lm.selectChatModels()` or `model.sendRequest()`.
  let visionModel: vscode.LanguageModelChat | undefined;
  const resolveVisionModel = async (): Promise<vscode.LanguageModelChat> => {
    if (visionModel) {
      return visionModel;
    }
    // Matching strategies:
    // 1. Exact id match (full internal model id)
    // 2. Vendor:id partial (e.g. "opencodego:mimo-v2.5")
    // 3. Name or id substring (e.g. "mimo-v2.5" or "Mimo V2.5")
    // Filter out agent-host variants — they use a different transport and
    // don't have vision support. Prefer non-agent models.
    const nonAgent = (models: readonly vscode.LanguageModelChat[]) => models.filter((m) => !m.id.includes("-agent:"));

    let visionModels = nonAgent(await vscode.lm.selectChatModels({ id: visionModelId }));
    if (visionModels.length === 0) {
      // Try matching by name substring across all providers
      const allVisible = nonAgent(await vscode.lm.selectChatModels({}));
      visionModels = allVisible.filter(
        (m) =>
          m.id.toLowerCase().includes(visionModelId.toLowerCase()) ||
          m.name.toLowerCase().includes(visionModelId.toLowerCase()) ||
          m.family.toLowerCase().includes(visionModelId.toLowerCase()),
      );
    }
    if (visionModels.length === 0) {
      throw new Error(`Vision model "${visionModelId}" not found. ` + `Run "OpenCode Go: Configure Vision Proxy" to see available models.`);
    }

    // All models that matched are candidates. `selectChatModels` returns
    // `LanguageModelChat` which does not expose capabilities in the stable
    // API, so we just use the first match. Most vision models handle image
    // input gracefully — models without vision will report the error.
    visionModel = visionModels[0];
    return visionModel;
  };

  // Whole-conversation mode (opencodego.visionProxyWholeConversation): one
  // request over all messages, so descriptions carry full conversation context.
  if (describeWholeConversation) {
    const imageIndices: number[] = [];
    const allHashes: string[] = [];
    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      const imageParts = msg.content.filter(
        (part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/"),
      );
      if (imageParts.length === 0) {
        continue;
      }
      imageIndices.push(index);
      allHashes.push(...imageParts.map((part) => imageDescriptionKey(dataPartToBase64(part.data))));
    }
    if (imageIndices.length > 0) {
      cacheMisses++;
      const model = await resolveVisionModel();
      const response = await model.sendRequest(buildVisionRequest(messages, visionPrompt), {}, token);
      let fullDescription = "";
      for await (const part of response.text) {
        fullDescription += part;
      }
      if (fullDescription) {
        storeImageDescriptions(allHashes, fullDescription);
        for (const index of imageIndices) {
          descriptions.set(index, fullDescription);
        }
      }
    }
    return { descriptions, cacheHits, cacheMisses };
  }

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const imageParts = msg.content.filter(
      (part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/"),
    );
    if (imageParts.length === 0) {
      continue;
    }
    const hashes = imageParts.map((part) => imageDescriptionKey(dataPartToBase64(part.data)));

    // All images already described → reuse the cached text, no model request.
    const cachedDescription = lookupImageDescriptions(hashes);
    if (cachedDescription !== undefined) {
      cacheHits++;
      descriptions.set(index, cachedDescription);
      continue;
    }

    // At least one new image → describe only this message and cache the result.
    cacheMisses++;
    const model = await resolveVisionModel();
    const response = await model.sendRequest(buildVisionRequest([msg], visionPrompt), {}, token);
    let fullDescription = "";
    for await (const part of response.text) {
      fullDescription += part;
    }
    if (!fullDescription) {
      continue;
    }
    storeImageDescriptions(hashes, fullDescription);
    descriptions.set(index, fullDescription);
  }

  return { descriptions, cacheHits, cacheMisses };
}

/**
 * QuickPick to configure vision proxy model and prompt.
 * Clean list of model names (no ugly IDs), with "None" to disable
 * and "Customize prompt..." to edit the description instruction.
 * Saves to globalState; toggles the visionProxy boolean accordingly.
 */
export async function showVisionProxyPicker(context: vscode.ExtensionContext): Promise<void> {
  const currentModelId = context.globalState.get<string>(VISION_PROXY_MODEL_ID_KEY, "");
  const currentPrompt = context.globalState.get<string>(VISION_PROXY_PROMPT_KEY, "") || DEFAULT_VISION_PROXY_PROMPT;

  // --- Build the set of vision-capable model IDs ---
  const visionCapableIds = new Set<string>();
  const snapshot = getModelMetadataSnapshot();
  if (snapshot) {
    for (const vendor of [GO_VENDOR, ZEN_VENDOR] as const) {
      const provider = snapshot.providers[vendor];
      if (!provider) continue;
      for (const [id, meta] of Object.entries(provider)) {
        if (meta.supportsVision) visionCapableIds.add(`${vendor}:${id}`);
      }
    }
  }
  for (const family of VISION_CAPABLE_MODELS) {
    visionCapableIds.add(`copilot:${family}`);
  }

  // --- Build QuickPick items from available models ---
  const allModels = (await vscode.lm.selectChatModels({})).filter((m) => !m.id.includes("-agent:"));

  const modelItems = allModels
    .map((m) => {
      const rawId = resolveRawModelId(m.id);
      const vendor = resolveVendorFromId(m.id);
      const lookupId = `${vendor}:${rawId}`;
      const fromLookup = visionCapableIds.has(lookupId);
      const fromName = [...visionCapableIds].some((id) => m.id.includes(id.replace(/^(opencodego|opencodezen|copilot):/, "")));
      const supportsVision = fromLookup || fromName;
      return {
        label: m.name,
        description: supportsVision ? "$(eye)" : "",
        detail: supportsVision ? (m.id === currentModelId ? "currently configured" : "vision-capable") : "",
        picked: m.id === currentModelId,
        _id: m.id,
        _kind: "model" as const,
        _supportsVision: supportsVision,
      };
    })
    .filter((m) => m._supportsVision);

  if (modelItems.length === 0) {
    vscode.window.showInformationMessage(
      "No vision-capable models found. Make sure you have a Copilot Chat provider with vision models installed.",
    );
    return;
  }

  modelItems.sort((a, b) => {
    if (a._id === currentModelId) return -1;
    if (b._id === currentModelId) return 1;
    return a.label.localeCompare(b.label);
  });

  const items: {
    label: string;
    description?: string;
    detail?: string;
    picked?: boolean;
    _id?: string;
    _kind: "none" | "prompt" | "model" | "separator";
    _supportsVision?: boolean;
    kind?: vscode.QuickPickItemKind;
  }[] = [
    { label: "$(circle-slash) None (disable)", detail: currentModelId ? "" : "currently selected", picked: !currentModelId, _kind: "none" },
    { label: "", kind: vscode.QuickPickItemKind.Separator, _kind: "separator" },
    {
      label: "$(edit) Customize description prompt...",
      description: "$(info) Sets how the vision model describes images",
      _kind: "prompt",
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator, _kind: "separator" },
    ...modelItems,
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Pick a model, customize the prompt, or disable",
    title: "OpenCode Go — Vision Proxy",
    matchOnDescription: true,
  });

  if (!picked || !("_kind" in picked)) return;

  // --- "Customize prompt..." ---
  if (picked._kind === "prompt") {
    const newPrompt = await vscode.window.showInputBox({
      title: "Vision Proxy — Description Prompt",
      prompt: "Prompt sent to the vision model to describe the image.",
      value: currentPrompt,
      placeHolder: DEFAULT_VISION_PROXY_PROMPT,
      validateInput: (value: string) => (value.trim() ? undefined : "Prompt cannot be empty."),
    });
    if (newPrompt === undefined) return; // cancelled
    await context.globalState.update(VISION_PROXY_PROMPT_KEY, newPrompt.trim());
    vscode.window.showInformationMessage("Vision proxy prompt updated.");
    return;
  }

  // --- "None" ---
  if (picked._kind === "none") {
    await context.globalState.update(VISION_PROXY_MODEL_ID_KEY, "");
    vscode.window.showInformationMessage("Vision proxy disabled.");
    return;
  }

  // --- Model selected ---
  if (!picked._id) return;
  await context.globalState.update(VISION_PROXY_MODEL_ID_KEY, picked._id);
  vscode.window.showInformationMessage(`Vision proxy set to: ${picked.label}`);
}
