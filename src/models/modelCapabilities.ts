export interface StableModelCapabilities {
  imageInput: boolean;
  toolCalling: true;
  supportsImageToText: boolean;
  supportsToolCalling: true;
}

/** Build model capabilities that are safe for regular Marketplace installs. */
export function buildStableModelCapabilities(supportsVision: boolean): StableModelCapabilities {
  return {
    imageInput: supportsVision,
    toolCalling: true,
    supportsImageToText: supportsVision,
    supportsToolCalling: true,
  };
}
