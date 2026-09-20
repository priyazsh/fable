import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

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
