/**
 * Typed bridge to the Rust settings store.
 *
 * Rust owns settings so the command runner and the UI cannot disagree; the
 * frontend treats `getSettings`/`setSettings` as the only source of truth and
 * always adopts the sanitised value Rust returns.
 */

import { invoke } from "@tauri-apps/api/core";

import { DEFAULT_SETTINGS, type Settings } from "@/state/workspace";

import { hasTauri } from "./shell";

export async function getSettings(): Promise<Settings> {
  if (!hasTauri()) return DEFAULT_SETTINGS;
  try {
    return await invoke<Settings>("get_settings");
  } catch (error) {
    console.error("get_settings failed", error);
    return DEFAULT_SETTINGS;
  }
}

/** Persists settings and returns the value Rust actually stored. */
export async function setSettings(settings: Settings): Promise<Settings> {
  if (!hasTauri()) return settings;
  return invoke<Settings>("set_settings", { settings });
}

export async function settingsFile(): Promise<string | null> {
  if (!hasTauri()) return null;
  try {
    return await invoke<string>("settings_file");
  } catch {
    return null;
  }
}

export async function availableShells(): Promise<string[]> {
  if (!hasTauri()) return [];
  try {
    return await invoke<string[]>("available_shells");
  } catch (error) {
    console.error("available_shells failed", error);
    return [];
  }
}

/** Monospace families worth offering; filtered to what is actually installed. */
const FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrains Mono",
  "CaskaydiaCove Nerd Font",
  "FiraCode Nerd Font",
  "Hack Nerd Font",
  "Adwaita Mono",
  "Cascadia Code",
  "Fira Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "SF Mono",
  "Hack",
  "Iosevka",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Menlo",
  "Monaco",
  "Consolas",
];

/**
 * Installed monospace families, detected through the font-loading API rather
 * than by asking the OS, which needs no extra dependency.
 */
export function installedFonts(): string[] {
  if (typeof document === "undefined" || !document.fonts) return [];
  return FONT_CANDIDATES.filter((family) => {
    try {
      return document.fonts.check(`12px "${family}"`);
    } catch {
      return false;
    }
  });
}
