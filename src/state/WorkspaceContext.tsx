import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

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
    fetchWorkspaceInfo().then((info) => {
      if (!cancelled && info) dispatch({ type: "info/loaded", info });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => state, [state]);

  return (
    <StateContext.Provider value={value}>
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
