import { describe, expect, test } from "bun:test";

import { resolveBinding } from "./keymap";
import {
  abbreviatePath,
  activeSessionOf,
  activeTabOf,
  collectLeaves,
  createInitialWorkspace,
  workspaceReducer,
  type PaneNode,
  type Workspace,
  type WorkspaceAction,
} from "./workspace";

/** Applies a sequence of actions, which is how the shell actually drives state. */
function run(state: Workspace, ...actions: WorkspaceAction[]): Workspace {
  return actions.reduce(workspaceReducer, state);
}

function panesOf(state: Workspace): number {
  const tab = activeTabOf(state);
  return tab ? collectLeaves(tab.root).length : 0;
}

function key(
  code: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    code,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  } as KeyboardEvent;
}

describe("initial workspace", () => {
  test("opens one tab with a single pane and session", () => {
    const state = createInitialWorkspace();
    expect(state.tabs).toHaveLength(1);
    expect(panesOf(state)).toBe(1);
    expect(Object.keys(state.sessions)).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });
});

describe("tabs", () => {
  test("opening a tab activates it", () => {
    const state = run(createInitialWorkspace(), { type: "tab/open" });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1].id);
  });

  test("closing the active tab falls back to a neighbour", () => {
    let state = run(createInitialWorkspace(), { type: "tab/open" }, { type: "tab/open" });
    const closed = state.activeTabId;
    state = run(state, { type: "tab/close", tabId: closed });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    expect(state.tabs.some((tab) => tab.id === closed)).toBe(false);
  });

  test("closing a background tab leaves the active tab alone", () => {
    let state = run(createInitialWorkspace(), { type: "tab/open" });
    const active = state.activeTabId;
    state = run(state, { type: "tab/close", tabId: state.tabs[0].id });
    expect(state.activeTabId).toBe(active);
  });

  test("closing the final tab leaves a fresh one rather than an empty shell", () => {
    const state = createInitialWorkspace();
    const next = run(state, { type: "tab/close", tabId: state.activeTabId });
    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0].id).not.toBe(state.tabs[0].id);
    expect(Object.keys(next.sessions)).toHaveLength(1);
  });

  test("cycling wraps in both directions", () => {
    let state = run(createInitialWorkspace(), { type: "tab/open" }, { type: "tab/open" });
    expect(state.activeTabId).toBe(state.tabs[2].id);
    state = run(state, { type: "tab/cycle", delta: 1 });
    expect(state.activeTabId).toBe(state.tabs[0].id);
    state = run(state, { type: "tab/cycle", delta: -1 });
    expect(state.activeTabId).toBe(state.tabs[2].id);
  });

  test("activating an out-of-range index is a no-op", () => {
    const state = createInitialWorkspace();
    expect(run(state, { type: "tab/activateIndex", index: 5 })).toBe(state);
  });
});

describe("panes", () => {
  test("splitting nests a tree and focuses the new pane", () => {
    const state = run(createInitialWorkspace(), { type: "pane/split", direction: "row" });
    const tab = activeTabOf(state)!;
    expect(tab.root.kind).toBe("split");
    expect(panesOf(state)).toBe(2);
    expect(Object.keys(state.sessions)).toHaveLength(2);

    const root = tab.root as Extract<PaneNode, { kind: "split" }>;
    expect(root.direction).toBe("row");
    expect(tab.activePaneId).toBe((root.children[1] as { id: string }).id);
  });

  test("splits nest arbitrarily", () => {
    const state = run(
      createInitialWorkspace(),
      { type: "pane/split", direction: "row" },
      { type: "pane/split", direction: "column" },
      { type: "pane/split", direction: "row" },
    );
    expect(panesOf(state)).toBe(4);
  });

  test("closing a pane collapses the sibling and prunes its session", () => {
    let state = run(createInitialWorkspace(), { type: "pane/split", direction: "row" });
    expect(Object.keys(state.sessions)).toHaveLength(2);

    state = run(state, { type: "pane/close" });
    expect(panesOf(state)).toBe(1);
    expect(activeTabOf(state)!.root.kind).toBe("leaf");
    expect(Object.keys(state.sessions)).toHaveLength(1);
  });

  test("closing the last pane in a tab closes the tab", () => {
    let state = run(createInitialWorkspace(), { type: "tab/open" });
    expect(state.tabs).toHaveLength(2);
    state = run(state, { type: "pane/close" });
    expect(state.tabs).toHaveLength(1);
  });

  test("the active pane always survives a close", () => {
    let state = run(
      createInitialWorkspace(),
      { type: "pane/split", direction: "row" },
      { type: "pane/split", direction: "column" },
    );
    state = run(state, { type: "pane/close" });
    const tab = activeTabOf(state)!;
    const ids = collectLeaves(tab.root).map((leaf) => leaf.id);
    expect(ids).toContain(tab.activePaneId);
  });

  test("resizing updates the split fractions", () => {
    let state = run(createInitialWorkspace(), { type: "pane/split", direction: "row" });
    const root = activeTabOf(state)!.root as Extract<PaneNode, { kind: "split" }>;
    state = run(state, { type: "pane/resize", nodeId: root.id, sizes: [0.3, 0.7] });
    const resized = activeTabOf(state)!.root as Extract<PaneNode, { kind: "split" }>;
    expect(resized.sizes).toEqual([0.3, 0.7]);
  });
});

describe("workspace info", () => {
  test("adopts the real cwd for untouched sessions", () => {
    const state = run(createInitialWorkspace(), {
      type: "info/loaded",
      info: {
        cwd: "/home/dev/app",
        home: "/home/dev",
        os: "linux",
        arch: "x86_64",
        appVersion: "0.1.0",
      },
    });
    expect(Object.values(state.sessions)[0].cwd).toBe("/home/dev/app");
  });

  test("new tabs inherit the real cwd", () => {
    const state = run(
      createInitialWorkspace(),
      {
        type: "info/loaded",
        info: {
          cwd: "/home/dev/app",
          home: "/home/dev",
          os: "linux",
          arch: "x86_64",
          appVersion: "0.1.0",
        },
      },
      { type: "tab/open" },
    );
    expect(Object.values(state.sessions).every((s) => s.cwd === "/home/dev/app")).toBe(true);
  });
});

describe("abbreviatePath", () => {
  test("shortens paths under home", () => {
    expect(abbreviatePath("/home/dev/app", "/home/dev")).toBe("~/app");
    expect(abbreviatePath("/home/dev", "/home/dev")).toBe("~");
    expect(abbreviatePath("C:\\Users\\dev\\app", "C:\\Users\\dev")).toBe("~\\app");
  });

  test("leaves unrelated paths and a sibling prefix alone", () => {
    expect(abbreviatePath("/etc/hosts", "/home/dev")).toBe("/etc/hosts");
    expect(abbreviatePath("/home/developer", "/home/dev")).toBe("/home/developer");
    expect(abbreviatePath("/home/dev/app", null)).toBe("/home/dev/app");
  });
});

describe("keymap", () => {
  test("resolves the shell chords", () => {
    expect(resolveBinding(key("KeyT", { ctrl: true, shift: true }))?.command).toEqual({
      type: "tab/open",
    });
    expect(resolveBinding(key("KeyD", { ctrl: true, shift: true }))?.command).toEqual({
      type: "pane/split",
      direction: "row",
    });
    expect(resolveBinding(key("Digit3", { ctrl: true }))?.command).toEqual({
      type: "tab/activateIndex",
      index: 2,
    });
  });

  test("distinguishes Ctrl+Tab from Ctrl+Shift+Tab", () => {
    expect(resolveBinding(key("Tab", { ctrl: true }))?.command).toEqual({
      type: "tab/cycle",
      delta: 1,
    });
    expect(resolveBinding(key("Tab", { ctrl: true, shift: true }))?.command).toEqual({
      type: "tab/cycle",
      delta: -1,
    });
  });

  test("lets unbound and bare keys through", () => {
    expect(resolveBinding(key("KeyT"))).toBeUndefined();
    expect(resolveBinding(key("Tab"))).toBeUndefined();
    expect(resolveBinding(key("KeyQ", { ctrl: true, shift: true }))).toBeUndefined();
  });

  test("context-dependent chords resolve to @-prefixed commands", () => {
    expect(resolveBinding(key("KeyW", { ctrl: true, shift: true }))?.command).toEqual({
      type: "@closeTab",
    });
    expect(resolveBinding(key("KeyL", { ctrl: true }))?.command).toEqual({
      type: "@clearSession",
    });
    expect(resolveBinding(key("KeyW", { ctrl: true }))).toBeUndefined();
  });
});

describe("timeline", () => {
  function startCommand(state: Workspace, input: string) {
    const session = activeSessionOf(state)!;
    return workspaceReducer(state, {
      type: "entry/start",
      sessionId: session.id,
      entry: {
        id: `e-${input}`,
        kind: "command",
        input,
        cwd: session.cwd,
        chunks: [],
        exitCode: null,
        durationMs: null,
        running: true,
      },
    });
  }

  test("a command entry streams output then settles on an exit code", () => {
    let state = startCommand(createInitialWorkspace(), "git status");
    state = run(
      state,
      { type: "entry/output", entryId: "e-git status", stream: "stdout", text: "On branch " },
      { type: "entry/output", entryId: "e-git status", stream: "stdout", text: "main\n" },
      { type: "entry/exit", entryId: "e-git status", exitCode: 0, durationMs: 120 },
    );

    const entry = state.entries["e-git status"];
    expect(entry.kind).toBe("command");
    if (entry.kind !== "command") return;
    // Same-stream writes merge, so a chatty build does not grow the array.
    expect(entry.chunks).toEqual([{ stream: "stdout", text: "On branch main\n" }]);
    expect(entry.running).toBe(false);
    expect(entry.exitCode).toBe(0);
    expect(entry.durationMs).toBe(120);
  });

  test("stdout and stderr stay separable and ordered", () => {
    let state = startCommand(createInitialWorkspace(), "build");
    state = run(
      state,
      { type: "entry/output", entryId: "e-build", stream: "stdout", text: "compiling\n" },
      { type: "entry/output", entryId: "e-build", stream: "stderr", text: "warning\n" },
      { type: "entry/output", entryId: "e-build", stream: "stdout", text: "done\n" },
    );
    const entry = state.entries["e-build"];
    if (entry.kind !== "command") throw new Error("expected a command entry");
    expect(entry.chunks.map((chunk) => chunk.stream)).toEqual(["stdout", "stderr", "stdout"]);
  });

  test("a kill reports a null exit code", () => {
    let state = startCommand(createInitialWorkspace(), "sleep 100");
    state = run(state, {
      type: "entry/exit",
      entryId: "e-sleep 100",
      exitCode: null,
      durationMs: 900,
    });
    const entry = state.entries["e-sleep 100"];
    if (entry.kind !== "command") throw new Error("expected a command entry");
    expect(entry.running).toBe(false);
    expect(entry.exitCode).toBeNull();
  });

  test("output for a vanished entry is dropped rather than throwing", () => {
    const state = createInitialWorkspace();
    expect(
      run(state, { type: "entry/output", entryId: "gone", stream: "stdout", text: "x" }),
    ).toBe(state);
    expect(run(state, { type: "entry/exit", entryId: "gone", exitCode: 0, durationMs: 1 })).toBe(
      state,
    );
  });

  test("history records submissions and skips consecutive repeats", () => {
    let state = startCommand(createInitialWorkspace(), "ls");
    state = startCommand(state, "ls");
    state = startCommand(state, "pwd");
    expect(activeSessionOf(state)!.history).toEqual(["ls", "pwd"]);
  });

  test("a task entry fills in its response", () => {
    const session = activeSessionOf(createInitialWorkspace())!;
    let state = run(createInitialWorkspace(), {
      type: "entry/start",
      sessionId: session.id,
      entry: { id: "t1", kind: "task", input: "fix the build", cwd: session.cwd, response: null },
    });
    expect((state.entries.t1 as { response: string | null }).response).toBeNull();
    state = run(state, { type: "entry/response", entryId: "t1", response: "done" });
    expect((state.entries.t1 as { response: string | null }).response).toBe("done");
  });

  test("clearing drops the session's entries but keeps its history", () => {
    let state = startCommand(createInitialWorkspace(), "ls");
    const session = activeSessionOf(state)!;
    state = run(state, { type: "session/clear", sessionId: session.id });
    expect(activeSessionOf(state)!.entryIds).toEqual([]);
    expect(activeSessionOf(state)!.history).toEqual(["ls"]);
    expect(Object.keys(state.entries)).toEqual([]);
  });

  test("cd is recorded on the session", () => {
    let state = createInitialWorkspace();
    const session = activeSessionOf(state)!;
    state = run(state, { type: "session/cwd", sessionId: session.id, cwd: "/tmp" });
    expect(activeSessionOf(state)!.cwd).toBe("/tmp");
  });

  test("closing a pane discards the entries it owned", () => {
    let state = run(createInitialWorkspace(), { type: "pane/split", direction: "row" });
    state = startCommand(state, "ls");
    expect(Object.keys(state.entries)).toHaveLength(1);

    state = run(state, { type: "pane/close" });
    expect(Object.keys(state.entries)).toHaveLength(0);
  });
});
