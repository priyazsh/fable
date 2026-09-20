/**
 * Typed bridge to the Rust command runner.
 *
 * Everything that crosses the Tauri IPC boundary lives in `src/platform`, so
 * the UI never calls `invoke` directly and stays runnable in a plain browser
 * during development (where every call degrades to a no-op).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { OutputStream } from "@/state/workspace";

export interface CommandOutputEvent {
  entryId: string;
  stream: OutputStream;
  text: string;
}

export interface CommandExitEvent {
  entryId: string;
  /** `null` when the process was terminated by a signal. */
  exitCode: number | null;
  durationMs: number;
}

/** True when running inside the Tauri webview rather than a bare browser. */
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const noopUnlisten: UnlistenFn = () => {};

/* ------------------------------------------------------------------ */
/* Program lookup                                                      */
/* ------------------------------------------------------------------ */

/**
 * PATH lookups are stable for the lifetime of the process and are consulted on
 * every keystroke to render the routing hint, so they are cached.
 */
const probed = new Map<string, boolean>();

/** Synchronous cache read; `undefined` means "not probed yet". */
export function cachedCommand(program: string): boolean | undefined {
  return probed.get(program);
}

export async function ensureCommand(program: string): Promise<boolean> {
  const cached = probed.get(program);
  if (cached !== undefined) return cached;
  if (!program || !hasTauri()) return false;

  let exists = false;
  try {
    exists = await invoke<boolean>("command_exists", { name: program });
  } catch (error) {
    console.error("command_exists failed", error);
  }
  probed.set(program, exists);
  return exists;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export async function runCommand(entryId: string, input: string, cwd: string): Promise<void> {
  if (!hasTauri()) throw new Error("command execution requires the desktop app");
  await invoke("run_command", { entryId, input, cwd });
}

export async function killCommand(entryId: string): Promise<void> {
  if (!hasTauri()) return;
  try {
    await invoke("kill_command", { entryId });
  } catch (error) {
    console.error("kill_command failed", error);
  }
}

/** Resolves a `cd` target. Rejects with a shell-style message. */
export async function resolveDir(cwd: string, target: string | undefined): Promise<string> {
  if (!hasTauri()) throw new Error("cd requires the desktop app");
  return invoke<string>("resolve_dir", { cwd, target: target ?? null });
}

export function onCommandOutput(
  handler: (event: CommandOutputEvent) => void,
): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(noopUnlisten);
  return listen<CommandOutputEvent>("command://output", (event) => handler(event.payload));
}

export function onCommandExit(handler: (event: CommandExitEvent) => void): Promise<UnlistenFn> {
  if (!hasTauri()) return Promise.resolve(noopUnlisten);
  return listen<CommandExitEvent>("command://exit", (event) => handler(event.payload));
}
