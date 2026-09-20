/**
 * Workspace state: tabs, panes, sessions and the command/task timeline.
 *
 * A session owns an ordered list of timeline entries. Entries are stored in a
 * flat map keyed by id so streaming output can be applied in O(1) without
 * walking every session.
 *
 * The pane layout is a binary split tree, the smallest shape that expresses
 * arbitrarily nested splits.
 *
 * The reducer is pure: id generation is seeded from `state.seq` rather than a
 * module-level counter, so React StrictMode's double invocation is harmless.
 */

export type TabId = string;
export type PaneId = string;
export type NodeId = string;
export type SessionId = string;
export type EntryId = string;

/** `row` splits left/right, `column` splits top/bottom. Mirrors flex-direction. */
export type SplitDirection = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; id: PaneId; sessionId: SessionId }
  | {
      kind: "split";
      id: NodeId;
      direction: SplitDirection;
      children: [PaneNode, PaneNode];
      /** Fractions of the parent along `direction`; always sums to 1. */
      sizes: [number, number];
    };

export type OutputStream = "stdout" | "stderr";

export interface OutputChunk {
  stream: OutputStream;
  text: string;
}

/** Something the user ran. */
export interface CommandEntry {
  id: EntryId;
  kind: "command";
  input: string;
  cwd: string;
  chunks: OutputChunk[];
  /** `null` while running, or when the process was killed by a signal. */
  exitCode: number | null;
  durationMs: number | null;
  running: boolean;
}

/**
 * Provider-neutral view of what the agent is doing. Mirrors `agent::AgentStep`
 * in Rust; the Rust side pins this wire format with a test.
 *
 * There is deliberately no thinking/reasoning variant: the backend drops those
 * blocks rather than forwarding them (spec §12).
 */
export type AgentStep =
  | { kind: "started"; sessionId: string | null; model: string | null }
  /** Prose. Arrives as deltas and is merged on arrival. */
  | { kind: "text"; text: string }
  /** Liveness only — `0` means "working", never any reasoning content. */
  | { kind: "progress"; tokens: number }
  /** Terminal step; `result` carries the message when `isError` is set. */
  | { kind: "done"; result: string | null; isError: boolean; costUsd: number | null };

/** Something the user asked the agent to do. */
export interface TaskEntry {
  id: EntryId;
  kind: "task";
  input: string;
  cwd: string;
  steps: AgentStep[];
  running: boolean;
  /** Set when the backend could not start, or died without a result. */
  error: string | null;
  durationMs: number | null;
}

export type Entry = CommandEntry | TaskEntry;

export interface Session {
  id: SessionId;
  title: string;
  cwd: string;
  entryIds: EntryId[];
  /** Submitted inputs, oldest first, for up-arrow recall. */
  history: string[];
}

export interface Tab {
  id: TabId;
  title: string;
  root: PaneNode;
  activePaneId: PaneId;
}

/** Where a newly opened tab starts. Mirrors the Rust enum. */
export type NewTabCwd = "cwd" | "home";

/** Agent backend. Mirrors `providers::Provider` in Rust. */
export type Provider = "anthropic" | "openai";

/** Mirrors `settings::Settings` in Rust. */
export interface Settings {
  fontFamily: string;
  fontSize: number;
  /** `null` means "use $SHELL". */
  shell: string | null;
  newTabCwd: NewTabCwd;
  provider: Provider;
  /** `null` uses the provider's default model. */
  agentModel: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "ui-monospace",
  fontSize: 13,
  shell: null,
  newTabCwd: "cwd",
  provider: "anthropic",
  agentModel: null,
};

/** Snapshot returned by the `workspace_info` Rust command. */
export interface WorkspaceInfo {
  cwd: string;
  home: string | null;
  os: string;
  arch: string;
  appVersion: string;
}

/** Section the settings panel should jump to when opened contextually. */
export type SettingsFocus = "agent";

export interface Workspace {
  tabs: Tab[];
  activeTabId: TabId;
  sessions: Record<SessionId, Session>;
  entries: Record<EntryId, Entry>;
  info: WorkspaceInfo | null;
  settings: Settings;
  settingsOpen: boolean;
  /** Set when settings were opened from a specific piece of friction. */
  settingsFocus: SettingsFocus | null;
  /** Monotonic id seed. Keeps the reducer pure. */
  seq: number;
}

export type WorkspaceAction =
  | { type: "info/loaded"; info: WorkspaceInfo }
  | { type: "tab/open" }
  | { type: "tab/close"; tabId: TabId }
  | { type: "tab/activate"; tabId: TabId }
  | { type: "tab/activateIndex"; index: number }
  | { type: "tab/cycle"; delta: number }
  | { type: "pane/split"; direction: SplitDirection }
  | { type: "pane/close" }
  | { type: "pane/focus"; paneId: PaneId }
  | { type: "pane/resize"; nodeId: NodeId; sizes: [number, number] }
  | { type: "entry/start"; sessionId: SessionId; entry: Entry }
  | { type: "entry/output"; entryId: EntryId; stream: OutputStream; text: string }
  | { type: "entry/exit"; entryId: EntryId; exitCode: number | null; durationMs: number }
  | { type: "entry/agentStep"; entryId: EntryId; step: AgentStep }
  | { type: "entry/agentExit"; entryId: EntryId; exitCode: number | null; durationMs: number }
  | { type: "entry/agentFailed"; entryId: EntryId; message: string }
  | { type: "session/cwd"; sessionId: SessionId; cwd: string }
  | { type: "session/clear"; sessionId: SessionId }
  | { type: "settings/loaded"; settings: Settings }
  | { type: "settings/toggle" }
  | { type: "settings/open"; focus?: SettingsFocus }
  | { type: "settings/close" };

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

export function collectLeaves(node: PaneNode): Extract<PaneNode, { kind: "leaf" }>[] {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
}

/** Returns a copy of `node` with the leaf `paneId` replaced by `replacement`. */
function replaceLeaf(node: PaneNode, paneId: PaneId, replacement: PaneNode): PaneNode {
  if (node.kind === "leaf") {
    return node.id === paneId ? replacement : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], paneId, replacement),
      replaceLeaf(node.children[1], paneId, replacement),
    ],
  };
}

/**
 * Removes the leaf `paneId`. The surviving sibling collapses into the removed
 * split's position. Returns `null` when the tree becomes empty.
 */
function removeLeaf(node: PaneNode, paneId: PaneId): PaneNode | null {
  if (node.kind === "leaf") {
    return node.id === paneId ? null : node;
  }
  const left = removeLeaf(node.children[0], paneId);
  const right = removeLeaf(node.children[1], paneId);
  if (left === null) return right;
  if (right === null) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

function updateSizes(node: PaneNode, nodeId: NodeId, sizes: [number, number]): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === nodeId) return { ...node, sizes };
  return {
    ...node,
    children: [
      updateSizes(node.children[0], nodeId, sizes),
      updateSizes(node.children[1], nodeId, sizes),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

/** Mints prefixed ids from a local counter so callers stay pure. */
function minter(start: number) {
  let seq = start;
  return {
    next: (prefix: string) => `${prefix}-${seq++}`,
    get seq() {
      return seq;
    },
  };
}

const DEFAULT_CWD = "~";

/** Starting directory for a new tab, per the `newTabCwd` setting. */
function startingCwd(state: Workspace): string {
  if (state.settings.newTabCwd === "home") {
    return state.info?.home ?? state.info?.cwd ?? DEFAULT_CWD;
  }
  return state.info?.cwd ?? DEFAULT_CWD;
}

function createTab(
  id: (prefix: string) => string,
  cwd: string,
  index: number,
): { tab: Tab; session: Session } {
  const session: Session = {
    id: id("session"),
    title: `terminal ${index}`,
    cwd,
    entryIds: [],
    history: [],
  };
  const pane: PaneNode = { kind: "leaf", id: id("pane"), sessionId: session.id };
  return {
    tab: { id: id("tab"), title: session.title, root: pane, activePaneId: pane.id },
    session,
  };
}

export function createInitialWorkspace(): Workspace {
  const ids = minter(0);
  const { tab, session } = createTab(ids.next, DEFAULT_CWD, 1);
  return {
    tabs: [tab],
    activeTabId: tab.id,
    sessions: { [session.id]: session },
    entries: {},
    info: null,
    settings: DEFAULT_SETTINGS,
    settingsOpen: false,
    settingsFocus: null,
    seq: ids.seq,
  };
}

/** Drops sessions, and their entries, once no pane references them. */
function prune(
  tabs: Tab[],
  sessions: Record<SessionId, Session>,
  entries: Record<EntryId, Entry>,
): { sessions: Record<SessionId, Session>; entries: Record<EntryId, Entry> } {
  const live = new Set(tabs.flatMap((tab) => collectLeaves(tab.root).map((l) => l.sessionId)));

  const nextSessions: Record<SessionId, Session> = {};
  const liveEntries = new Set<EntryId>();
  for (const [id, session] of Object.entries(sessions)) {
    if (!live.has(id)) continue;
    nextSessions[id] = session;
    for (const entryId of session.entryIds) liveEntries.add(entryId);
  }

  const nextEntries: Record<EntryId, Entry> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (liveEntries.has(id)) nextEntries[id] = entry;
  }
  return { sessions: nextSessions, entries: nextEntries };
}

/** Appends output, merging into the previous chunk when the stream matches. */
function appendChunk(chunks: OutputChunk[], stream: OutputStream, text: string): OutputChunk[] {
  const last = chunks[chunks.length - 1];
  if (last && last.stream === stream) {
    return [...chunks.slice(0, -1), { stream, text: last.text + text }];
  }
  return [...chunks, { stream, text }];
}

/**
 * Appends an agent step, coalescing the two kinds that arrive in bulk:
 * progress ticks and streamed prose deltas.
 */
function appendStep(steps: AgentStep[], step: AgentStep): AgentStep[] {
  const last = steps[steps.length - 1];
  if (last) {
    if (step.kind === "progress" && last.kind === "progress") {
      return [...steps.slice(0, -1), step];
    }
    // Providers stream prose one delta at a time; merging keeps the timeline
    // one paragraph per message rather than one per token.
    if (step.kind === "text" && last.kind === "text") {
      return [...steps.slice(0, -1), { kind: "text", text: last.text + step.text }];
    }
  }
  return [...steps, step];
}

/** Applies `change` to one entry, leaving state untouched if it is gone. */
function patchEntry(
  state: Workspace,
  entryId: EntryId,
  change: (entry: Entry) => Entry | null,
): Workspace {
  const entry = state.entries[entryId];
  if (!entry) return state;
  const next = change(entry);
  if (!next || next === entry) return state;
  return { ...state, entries: { ...state.entries, [entryId]: next } };
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  const ids = minter(state.seq);
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const activeTab = state.tabs[activeIndex];

  switch (action.type) {
    case "info/loaded": {
      // Adopt the real cwd for sessions still on the placeholder.
      const sessions = Object.fromEntries(
        Object.entries(state.sessions).map(([id, session]) => [
          id,
          session.cwd === DEFAULT_CWD ? { ...session, cwd: action.info.cwd } : session,
        ]),
      );
      return { ...state, info: action.info, sessions };
    }

    case "tab/open": {
      const { tab, session } = createTab(ids.next, startingCwd(state), state.tabs.length + 1);
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        sessions: { ...state.sessions, [session.id]: session },
        seq: ids.seq,
      };
    }

    case "tab/close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index === -1) return state;

      // Closing the final tab leaves a fresh one rather than an empty shell.
      if (state.tabs.length === 1) {
        const { tab, session } = createTab(ids.next, startingCwd(state), 1);
        return {
          ...state,
          tabs: [tab],
          activeTabId: tab.id,
          sessions: { [session.id]: session },
          entries: {},
          seq: ids.seq,
        };
      }

      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs[Math.min(index, tabs.length - 1)].id
          : state.activeTabId;
      return { ...state, tabs, activeTabId, ...prune(tabs, state.sessions, state.entries) };
    }

    case "tab/activate":
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;

    case "tab/activateIndex": {
      const tab = state.tabs[action.index];
      return tab ? { ...state, activeTabId: tab.id } : state;
    }

    case "tab/cycle": {
      if (state.tabs.length < 2) return state;
      const count = state.tabs.length;
      const next = (((activeIndex + action.delta) % count) + count) % count;
      return { ...state, activeTabId: state.tabs[next].id };
    }

    case "pane/split": {
      if (!activeTab) return state;
      const existing = collectLeaves(activeTab.root).find(
        (leaf) => leaf.id === activeTab.activePaneId,
      );
      if (!existing) return state;

      const session: Session = {
        id: ids.next("session"),
        title: activeTab.title,
        cwd: state.sessions[existing.sessionId]?.cwd ?? DEFAULT_CWD,
        entryIds: [],
        history: [],
      };
      const newPane: PaneNode = {
        kind: "leaf",
        id: ids.next("pane"),
        sessionId: session.id,
      };
      const split: PaneNode = {
        kind: "split",
        id: ids.next("split"),
        direction: action.direction,
        children: [existing, newPane],
        sizes: [0.5, 0.5],
      };
      const tabs = state.tabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              root: replaceLeaf(tab.root, activeTab.activePaneId, split),
              activePaneId: newPane.id,
            }
          : tab,
      );
      return {
        ...state,
        tabs,
        sessions: { ...state.sessions, [session.id]: session },
        seq: ids.seq,
      };
    }

    case "pane/close": {
      if (!activeTab) return state;
      const leaves = collectLeaves(activeTab.root);
      // The last pane in a tab means closing the tab itself.
      if (leaves.length === 1) {
        return workspaceReducer(state, { type: "tab/close", tabId: activeTab.id });
      }
      const root = removeLeaf(activeTab.root, activeTab.activePaneId);
      if (!root) return state;

      const remaining = collectLeaves(root);
      const closedIndex = leaves.findIndex((leaf) => leaf.id === activeTab.activePaneId);
      const nextActive = remaining[Math.min(closedIndex, remaining.length - 1)];
      const tabs = state.tabs.map((tab) =>
        tab.id === activeTab.id ? { ...tab, root, activePaneId: nextActive.id } : tab,
      );
      return { ...state, tabs, ...prune(tabs, state.sessions, state.entries) };
    }

    case "pane/focus": {
      if (!activeTab || activeTab.activePaneId === action.paneId) return state;
      const tabs = state.tabs.map((tab) =>
        tab.id === activeTab.id ? { ...tab, activePaneId: action.paneId } : tab,
      );
      return { ...state, tabs };
    }

    case "pane/resize": {
      if (!activeTab) return state;
      const tabs = state.tabs.map((tab) =>
        tab.id === activeTab.id
          ? { ...tab, root: updateSizes(tab.root, action.nodeId, action.sizes) }
          : tab,
      );
      return { ...state, tabs };
    }

    case "entry/start": {
      const session = state.sessions[action.sessionId];
      if (!session) return state;
      // Consecutive duplicates are not worth recalling.
      const history =
        session.history[session.history.length - 1] === action.entry.input
          ? session.history
          : [...session.history, action.entry.input];
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.id]: {
            ...session,
            entryIds: [...session.entryIds, action.entry.id],
            history,
          },
        },
        entries: { ...state.entries, [action.entry.id]: action.entry },
      };
    }

    case "entry/output":
      return patchEntry(state, action.entryId, (entry) =>
        entry.kind === "command"
          ? { ...entry, chunks: appendChunk(entry.chunks, action.stream, action.text) }
          : entry,
      );

    case "entry/exit":
      return patchEntry(state, action.entryId, (entry) =>
        entry.kind === "command"
          ? {
              ...entry,
              running: false,
              exitCode: action.exitCode,
              durationMs: action.durationMs,
            }
          : entry,
      );

    case "entry/agentStep":
      return patchEntry(state, action.entryId, (entry) =>
        entry.kind === "task"
          ? { ...entry, steps: appendStep(entry.steps, action.step) }
          : entry,
      );

    case "entry/agentExit":
      return patchEntry(state, action.entryId, (entry) => {
        if (entry.kind !== "task") return entry;
        // A backend that died without reporting a result owes an explanation.
        const finished = entry.steps.some((step) => step.kind === "done");
        const error =
          entry.error ??
          (finished || action.exitCode === 0
            ? null
            : action.exitCode === null
              ? "The agent was interrupted."
              : `The agent exited with code ${action.exitCode}.`);
        return { ...entry, running: false, durationMs: action.durationMs, error };
      });

    case "entry/agentFailed":
      return patchEntry(state, action.entryId, (entry) =>
        entry.kind === "task"
          ? { ...entry, running: false, error: action.message }
          : entry,
      );

    case "session/cwd": {
      const session = state.sessions[action.sessionId];
      if (!session || session.cwd === action.cwd) return state;
      return {
        ...state,
        sessions: { ...state.sessions, [session.id]: { ...session, cwd: action.cwd } },
      };
    }

    case "session/clear": {
      const session = state.sessions[action.sessionId];
      if (!session || session.entryIds.length === 0) return state;
      const cleared = new Set(session.entryIds);
      const entries = Object.fromEntries(
        Object.entries(state.entries).filter(([id]) => !cleared.has(id)),
      );
      return {
        ...state,
        sessions: { ...state.sessions, [session.id]: { ...session, entryIds: [] } },
        entries,
      };
    }

    case "settings/loaded":
      return { ...state, settings: action.settings };

    case "settings/toggle":
      return { ...state, settingsOpen: !state.settingsOpen, settingsFocus: null };

    case "settings/open":
      return { ...state, settingsOpen: true, settingsFocus: action.focus ?? null };

    case "settings/close":
      return state.settingsOpen
        ? { ...state, settingsOpen: false, settingsFocus: null }
        : state;
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

function activeSessionId(tab: Tab): SessionId {
  const leaves = collectLeaves(tab.root);
  return (leaves.find((leaf) => leaf.id === tab.activePaneId) ?? leaves[0]).sessionId;
}

export function activeTabOf(state: Workspace): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function activeSessionOf(state: Workspace): Session | undefined {
  const tab = activeTabOf(state);
  return tab ? state.sessions[activeSessionId(tab)] : undefined;
}

export function entriesOf(state: Workspace, session: Session): Entry[] {
  return session.entryIds
    .map((id) => state.entries[id])
    .filter((entry): entry is Entry => Boolean(entry));
}

/** Renders `/home/me/Works/forge` as `~/Works/forge` for display. */
export function abbreviatePath(path: string, home: string | null | undefined): string {
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest === "") return "~";
  return rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}
