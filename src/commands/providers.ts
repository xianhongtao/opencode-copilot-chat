import * as vscode from "vscode";
import { SETTING_ENABLED } from "../config";

/** Open the Settings UI filtered to the utility-model config keys. */
export async function configureUtilityModels(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@id:chat.byokUtilityModelDefault @id:chat.utilityModel @id:chat.utilitySmallModel",
  );
}

/**
 * Toggle whether a provider (`opencodego` / `opencodezen`) is registered at
 * all. Disabling removes the provider from the Language Models list and every
 * model picker — the provider's vendor contribution is gated by the same
 * `when` clause (`config.<vendor>.enabled`) and its runtime registration is
 * skipped. Previously configured BYOK groups and API keys are kept, so
 * re-enabling restores the provider exactly as it was.
 *
 * Provider registration happens at startup, so a window reload is required
 * for the change to take effect.
 */
export async function toggleProviderEnabled(vendor: string, displayName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(vendor);
  const current = cfg.get<boolean>(SETTING_ENABLED, true);
  const next = !current;
  await cfg.update("enabled", next, vscode.ConfigurationTarget.Global);

  const reload = await vscode.window.showInformationMessage(
    next
      ? `${displayName} re-enabled. Reload the window for the provider to appear in Language Models again.`
      : `${displayName} removed from Language Models. Reload the window for it to disappear from the model picker and the manage list. Your API key and group settings are kept.`,
    "Reload Now",
  );
  if (reload === "Reload Now") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}
