/**
 * Declarative keybinding table.
 *
 * `Shell` installs a single `keydown` listener that consults this table. Keys
 * that match nothing fall through untouched, which is what lets the prompt —
 * and, in milestone 4, the terminal — receive ordinary typing.
 *
 * Matching uses `KeyboardEvent.code` rather than `.key` so that chords stay
 * stable when a modifier changes the produced character (Ctrl+Shift+T reports
 * `key: "T"`, but always `code: "KeyT"`).
 */

import type { WorkspaceAction } from "./workspace";

/**
 * Bindings that need runtime context (which tab? which session?) are expressed
 * as `@`-prefixed commands and resolved by `Shell` against current state.
 */
export type ShellCommand =
  | WorkspaceAction
  | { type: "@closeTab" }
  | { type: "@clearSession" };

export interface KeyBinding {
  /** Display form, shown in the empty-session hint. */
  chord: string;
  label: string;
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  command: ShellCommand;
}

const tabDigits: KeyBinding[] = Array.from({ length: 9 }, (_, index) => ({
  chord: `Ctrl+${index + 1}`,
  label: `Switch to tab ${index + 1}`,
  code: `Digit${index + 1}`,
  ctrl: true,
  command: { type: "tab/activateIndex", index } as ShellCommand,
}));

export const KEYMAP: KeyBinding[] = [
  {
    chord: "Ctrl+Shift+T",
    label: "New tab",
    code: "KeyT",
    ctrl: true,
    shift: true,
    command: { type: "tab/open" },
  },
  {
    chord: "Ctrl+Shift+W",
    label: "Close tab",
    code: "KeyW",
    ctrl: true,
    shift: true,
    command: { type: "@closeTab" },
  },
  {
    chord: "Ctrl+Shift+D",
    label: "Split right",
    code: "KeyD",
    ctrl: true,
    shift: true,
    command: { type: "pane/split", direction: "row" },
  },
  {
    chord: "Ctrl+Shift+E",
    label: "Split down",
    code: "KeyE",
    ctrl: true,
    shift: true,
    command: { type: "pane/split", direction: "column" },
  },
  {
    chord: "Ctrl+Shift+X",
    label: "Close pane",
    code: "KeyX",
    ctrl: true,
    shift: true,
    command: { type: "pane/close" },
  },
  {
    chord: "Ctrl+L",
    label: "Clear",
    code: "KeyL",
    ctrl: true,
    command: { type: "@clearSession" },
  },
  {
    chord: "Ctrl+,",
    label: "Settings",
    code: "Comma",
    ctrl: true,
    command: { type: "settings/toggle" },
  },
  {
    chord: "Ctrl+Tab",
    label: "Next tab",
    code: "Tab",
    ctrl: true,
    command: { type: "tab/cycle", delta: 1 },
  },
  {
    chord: "Ctrl+Shift+Tab",
    label: "Previous tab",
    code: "Tab",
    ctrl: true,
    shift: true,
    command: { type: "tab/cycle", delta: -1 },
  },
  ...tabDigits,
];

function matches(event: KeyboardEvent, binding: KeyBinding): boolean {
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

/** Shortcut reference shown in an empty session. */
export const SHORTCUT_HELP: { chord: string; label: string }[] = [
  { chord: "Ctrl+Shift+T", label: "New tab" },
  { chord: "Ctrl+Shift+D", label: "Split right" },
  { chord: "Ctrl+Shift+E", label: "Split down" },
  { chord: "Ctrl+L", label: "Clear" },
  { chord: "Ctrl+C", label: "Interrupt" },
  { chord: "Ctrl+,", label: "Settings" },
];
