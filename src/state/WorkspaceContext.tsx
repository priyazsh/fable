import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

import { onAgentExit, onAgentStep } from "@/platform/agent";
import { getSettings } from "@/platform/settings";
import { onCommandExit, onCommandOutput } from "@/platform/shell";
import { fetchWorkspaceInfo } from "@/platform/workspace-info";

import {
  createInitialWorkspace,
  workspaceReducer,
  type Workspace,
  type WorkspaceAction,
} from "./workspace";

const StateContext = createContext<Workspace | null>(null);
const DispatchContext = createContext<Dispatch<WorkspaceAction> | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialWorkspace);

  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceInfo().then((info) => {
      if (!cancelled && info) dispatch({ type: "info/loaded", info });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then((settings) => {
      if (!cancelled) dispatch({ type: "settings/loaded", settings });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Typography is applied as custom properties on the root so every token that
  // derives from --font-size scales with it.
  useEffect(() => {
    const root = document.documentElement;
    const { fontFamily, fontSize } = state.settings;
    root.style.setProperty("--font-size", `${fontSize}px`);
    root.style.setProperty(
      "--font-mono",
      fontFamily === "ui-monospace"
        ? "var(--font-mono-system)"
        : `"${fontFamily}", var(--font-mono-system)`,
    );
  }, [state.settings.fontFamily, state.settings.fontSize]);

  // Command output arrives as events keyed by entry id, so a single pair of
  // listeners feeds every session.
  useEffect(() => {
    const output = onCommandOutput(({ entryId, stream, text }) =>
      dispatch({ type: "entry/output", entryId, stream, text }),
    );
    const exit = onCommandExit(({ entryId, exitCode, durationMs }) =>
      dispatch({ type: "entry/exit", entryId, exitCode, durationMs }),
    );
    return () => {
      void output.then((unlisten) => unlisten());
      void exit.then((unlisten) => unlisten());
    };
  }, []);

  // The agent streams the same way: steps keyed by entry id.
  useEffect(() => {
    const step = onAgentStep(({ entryId, step }) =>
      dispatch({ type: "entry/agentStep", entryId, step }),
    );
    const exit = onAgentExit(({ entryId, exitCode, durationMs }) =>
      dispatch({ type: "entry/agentExit", entryId, exitCode, durationMs }),
    );
    return () => {
      void step.then((unlisten) => unlisten());
      void exit.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useWorkspace(): Workspace {
  const state = useContext(StateContext);
  if (!state) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return state;
}

export function useWorkspaceDispatch(): Dispatch<WorkspaceAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error("useWorkspaceDispatch must be used inside <WorkspaceProvider>");
  return dispatch;
}
