/**
 * Typed bridge to the Rust `workspace_info` command.
 *
 * Everything that crosses the Tauri IPC boundary is wrapped in `src/platform`
 * so the UI never calls `invoke` directly and stays runnable in a plain
 * browser during development.
 */

import { invoke } from "@tauri-apps/api/core";

import type { WorkspaceInfo } from "@/state/workspace";

/** True when running inside the Tauri webview rather than a bare browser. */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo | null> {
  if (!hasTauri()) return null;
  try {
    return await invoke<WorkspaceInfo>("workspace_info");
  } catch (error) {
    console.error("workspace_info failed", error);
    return null;
  }
}
