/**
 * Declarative keybinding table.
 *
 * `Shell` installs a single `keydown` listener that consults this table. Keys
 * that match nothing fall through untouched, which is what lets Milestone 5
 * forward the remainder to the focused terminal without restructuring this.
 *
 * Matching uses `KeyboardEvent.code` rather than `.key` so that chords stay
 * stable when a modifier changes the produced character (Ctrl+Shift+T reports
 * `key: "T"`, but always `code: "KeyT"`).
 */

import type { WorkspaceAction } from "./workspace";

export interface KeyBinding {
  /** Display form, shown in the agent panel's shortcut list. */
  chord: string;
  label: string;
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: WorkspaceAction;
}

const tabDigits: KeyBinding[] = Array.from({ length: 9 }, (_, i) => ({
  chord: `Ctrl+${i + 1}`,
  label: `Switch to tab ${i + 1}`,
  code: `Digit${i + 1}`,
  ctrl: true,
  action: { type: "tab/activateIndex", index: i } as WorkspaceAction,
}));

export const KEYMAP: KeyBinding[] = [
  {
    chord: "Ctrl+Shift+T",
    label: "New tab",
    code: "KeyT",
    ctrl: true,
    shift: true,
    action: { type: "tab/open" },
  },
  {
    chord: "Ctrl+Shift+D",
    label: "Split right",
    code: "KeyD",
    ctrl: true,
    shift: true,
    action: { type: "pane/split", direction: "row" },
  },
  {
    chord: "Ctrl+Shift+E",
    label: "Split down",
    code: "KeyE",
    ctrl: true,
    shift: true,
    action: { type: "pane/split", direction: "column" },
  },
  {
    chord: "Ctrl+Shift+X",
    label: "Close pane",
    code: "KeyX",
    ctrl: true,
    shift: true,
    action: { type: "pane/close" },
  },
  {
    chord: "Ctrl+Shift+A",
    label: "Toggle agent panel",
    code: "KeyA",
    ctrl: true,
    shift: true,
    action: { type: "agent/toggle" },
  },
  {
    chord: "Ctrl+Tab",
    label: "Next tab",
    code: "Tab",
    ctrl: true,
    action: { type: "tab/cycle", delta: 1 },
  },
  {
    chord: "Ctrl+Shift+Tab",
    label: "Previous tab",
    code: "Tab",
    ctrl: true,
    shift: true,
    action: { type: "tab/cycle", delta: -1 },
  },
  ...tabDigits,
];

/**
 * `Ctrl+Shift+W` closes the active tab. It needs the current tab id, so it is
 * resolved by the caller rather than living in the static table.
 */
export const CLOSE_TAB_BINDING = {
  chord: "Ctrl+Shift+W",
  label: "Close tab",
  code: "KeyW",
  ctrl: true,
  shift: true,
} as const;

function matches(
  event: KeyboardEvent,
  binding: { code: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
): boolean {
  return (
    event.code === binding.code &&
    (event.ctrlKey || event.metaKey) === Boolean(binding.ctrl) &&
    event.shiftKey === Boolean(binding.shift) &&
    event.altKey === Boolean(binding.alt)
  );
}

/** The binding triggered by `event`, or `undefined` to let the key through. */
export function resolveBinding(event: KeyboardEvent): KeyBinding | undefined {
  return KEYMAP.find((binding) => matches(event, binding));
}

export function isCloseTab(event: KeyboardEvent): boolean {
  return matches(event, CLOSE_TAB_BINDING);
}

/** Shortcut reference shown in the agent panel. */
export const SHORTCUT_HELP: { chord: string; label: string }[] = [
  { chord: "Ctrl+Shift+T", label: "New tab" },
  { chord: "Ctrl+Shift+W", label: "Close tab" },
  { chord: "Ctrl+Shift+D", label: "Split right" },
  { chord: "Ctrl+Shift+E", label: "Split down" },
  { chord: "Ctrl+Shift+X", label: "Close pane" },
  { chord: "Ctrl+1…9", label: "Switch tab" },
  { chord: "Ctrl+Tab", label: "Cycle tabs" },
  { chord: "Ctrl+Shift+A", label: "Toggle agent" },
];
