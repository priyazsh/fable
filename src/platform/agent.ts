/**
 * Typed bridge to the agent backend.
 *
 * The backend is the Claude Code CLI, which uses the user's existing
 * credentials — there is no API key to configure. The event shape is
 * provider-neutral so a future OpenAI provider can emit the same steps.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentStep, Provider } from "@/state/workspace";

import { hasTauri } from "./shell";

export interface AgentStepEvent {
  entryId: string;
  step: AgentStep;
}

export interface AgentExitEvent {
  entryId: string;
  exitCode: number | null;
  durationMs: number;
}

const noopUnlisten: UnlistenFn = () => {};

export async function runAgentTask(
  entryId: string,
  input: string,
  cwd: string,
): Promise<void> {
  if (!hasTauri()) throw new Error("the agent requires the desktop app");
  await invoke("run_agent_task", { entryId, input, cwd });
}

export async function killAgent(entryId: string): Promise<void> {
  if (!hasTauri()) return;
  try {
    await invoke("kill_agent", { entryId });
  } catch (error) {
    console.error("kill_agent failed", error);
  }
}

/** Whether a task can run: a key is stored and a model is selected. */
export async function agentReady(): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("agent_ready");
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * Keys live in the OS keyring, never in Forge's config file and never in
 * frontend state — only their presence is ever reported back.
 */
export async function hasApiKey(provider: Provider): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("has_api_key", { provider });
  } catch {
    return false;
  }
}

export async function setApiKey(provider: Provider, key: string): Promise<void> {
  if (!hasTauri()) throw new Error("storing a key requires the desktop app");
  await invoke("set_api_key", { provider, key });
}

export async function clearApiKey(provider: Provider): Promise<void> {
  if (!hasTauri()) return;
  await invoke("clear_api_key", { provider });
}

/** Models the account can use. Fetched from the provider where possible. */
export async function listModels(provider: Provider): Promise<string[]> {
  if (!hasTauri()) return [];
  return invoke<string[]>("list_models", { provider });
}

export function onAgentStep(handler: (event: AgentStepEvent) => void): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(noopUnlisten);
  return listen<AgentStepEvent>("agent://step", (event) => handler(event.payload));
}

export function onAgentExit(handler: (event: AgentExitEvent) => void): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(noopUnlisten);
  return listen<AgentExitEvent>("agent://exit", (event) => handler(event.payload));
}
