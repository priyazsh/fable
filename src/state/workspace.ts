/**
 * Workspace state: tabs, panes and sessions.
 *
 * The pane layout is a binary split tree, which is the smallest shape that
 * expresses arbitrarily nested horizontal/vertical splits. A `Session` is
 * currently a thin record; the terminal runtime (Milestone 4) attaches PTY
 * handles to it without changing the tree.
 *
 * The reducer is pure: id generation is seeded from `state.seq` rather than a
 * module-level counter, so React StrictMode's double invocation is harmless.
 */

export type TabId = string;
export type PaneId = string;
export type NodeId = string;
export type SessionId = string;

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

export interface Session {
  id: SessionId;
  title: string;
  cwd: string;
}

export interface Tab {
  id: TabId;
  title: string;
  root: PaneNode;
  activePaneId: PaneId;
}

/** Snapshot returned by the `workspace_info` Rust command. */
export interface WorkspaceInfo {
  cwd: string;
  home: string | null;
  os: string;
  arch: string;
  appVersion: string;
}

export interface Workspace {
  tabs: Tab[];
  activeTabId: TabId;
  sessions: Record<SessionId, Session>;
  agentPanelOpen: boolean;
  info: WorkspaceInfo | null;
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
  | { type: "agent/toggle" };

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

function updateSizes(
  node: PaneNode,
  nodeId: NodeId,
  sizes: [number, number],
): PaneNode {
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

function createTab(
  id: (prefix: string) => string,
  cwd: string,
  index: number,
): { tab: Tab; session: Session } {
  const session: Session = {
    id: id("session"),
    title: `terminal ${index}`,
    cwd,
  };
  const pane: PaneNode = { kind: "leaf", id: id("pane"), sessionId: session.id };
  return {
    tab: {
      id: id("tab"),
      title: session.title,
      root: pane,
      activePaneId: pane.id,
    },
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
    agentPanelOpen: true,
    info: null,
    seq: ids.seq,
  };
}

/** Drops sessions no longer referenced by any pane. */
function pruneSessions(
  tabs: Tab[],
  sessions: Record<SessionId, Session>,
): Record<SessionId, Session> {
  const live = new Set(tabs.flatMap((tab) => collectLeaves(tab.root).map((l) => l.sessionId)));
  const next: Record<SessionId, Session> = {};
  for (const [id, session] of Object.entries(sessions)) {
    if (live.has(id)) next[id] = session;
  }
  return next;
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
      const cwd = state.info?.cwd ?? DEFAULT_CWD;
      const { tab, session } = createTab(ids.next, cwd, state.tabs.length + 1);
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
        const cwd = state.info?.cwd ?? DEFAULT_CWD;
        const { tab, session } = createTab(ids.next, cwd, 1);
        return {
          ...state,
          tabs: [tab],
          activeTabId: tab.id,
          sessions: { [session.id]: session },
          seq: ids.seq,
        };
      }

      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs[Math.min(index, tabs.length - 1)].id
          : state.activeTabId;
      return {
        ...state,
        tabs,
        activeTabId,
        sessions: pruneSessions(tabs, state.sessions),
      };
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
      const cwd = state.sessions[leafSessionId(activeTab)]?.cwd ?? DEFAULT_CWD;
      const session: Session = {
        id: ids.next("session"),
        title: activeTab.title,
        cwd,
      };
      const newPane: PaneNode = {
        kind: "leaf",
        id: ids.next("pane"),
        sessionId: session.id,
      };
      const existing = collectLeaves(activeTab.root).find(
        (leaf) => leaf.id === activeTab.activePaneId,
      );
      if (!existing) return state;

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
      return { ...state, tabs, sessions: pruneSessions(tabs, state.sessions) };
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

    case "agent/toggle":
      return { ...state, agentPanelOpen: !state.agentPanelOpen };
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

function leafSessionId(tab: Tab): SessionId {
  const leaf = collectLeaves(tab.root).find((l) => l.id === tab.activePaneId);
  return leaf?.sessionId ?? collectLeaves(tab.root)[0].sessionId;
}

export function activeTabOf(state: Workspace): Tab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function activeSessionOf(state: Workspace): Session | undefined {
  const tab = activeTabOf(state);
  return tab ? state.sessions[leafSessionId(tab)] : undefined;
}

/** Renders `/home/me/Works/forge` as `~/Works/forge` for display. */
export function abbreviatePath(path: string, home: string | null | undefined): string {
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest === "") return "~";
  return rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}
