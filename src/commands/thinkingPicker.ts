import * as vscode from "vscode";
import { CONFIG_SECTION } from "../config";
import { getSettings } from "../provider/settings";
import type { ThinkingSettings } from "../thinking";

/** Pick a model family then set its Thinking effort (writes config). */
export async function showThinkingEffortPicker(): Promise<void> {
  const families: { label: string; key: keyof ThinkingSettings; options: string[] }[] = [
    { label: "DeepSeek (deepseek-v4-*)", key: "deepseek", options: ["off", "low", "medium", "high", "max"] },
    { label: "GLM (glm-5, glm-5.1, glm-5.2)", key: "glm", options: ["off", "high", "max"] },
    { label: "Kimi (kimi-k2.*)", key: "kimi", options: ["on", "off"] },
    { label: "Mimo (mimo-v2.*)", key: "mimo", options: ["off", "low", "medium", "high"] },
    { label: "MiniMax (minimax-m*)", key: "minimax", options: ["off", "on"] },
    { label: "OpenAI GPT (gpt-*)", key: "openai", options: ["off", "low", "medium", "high", "xhigh"] },
    { label: "Qwen (qwen3.*)", key: "qwen", options: ["auto", "on", "off"] },
    { label: "Qwen Thinking Budget", key: "qwenBudget", options: ["auto", "4096", "16384", "32768", "81920"] },
  ];
  const settings = getSettings().thinking;
  const family = await vscode.window.showQuickPick(
    families.map((f) => ({ label: f.label, description: `current: ${settings[f.key]}`, family: f })),
    { placeHolder: "Pick a model family to configure Thinking" },
  );
  if (!family) return;
  const choice = await vscode.window.showQuickPick(family.family.options, {
    placeHolder: `Set ${family.family.label} → Thinking value`,
  });
  if (!choice) return;
  const cfg = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.thinking`);
  await cfg.update(family.family.key, choice, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`OpenCode Thinking — ${family.family.label}: ${choice}`);
}
