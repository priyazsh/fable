import { useEffect } from "react";

import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { resolveBinding } from "@/state/keymap";
import { activeSessionOf, activeTabOf } from "@/state/workspace";

import { PaneTree } from "./PaneTree";
import { StatusBar } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import styles from "./Shell.module.css";

export function Shell() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const tab = activeTabOf(workspace);
  const session = activeSessionOf(workspace);

  // A single window-level listener owns the shell's chords. Unmatched keys are
  // left alone so the prompt — and later the terminal — receives ordinary typing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const binding = resolveBinding(event);
      if (!binding) return;
      event.preventDefault();

      const command = binding.command;
      if (command.type === "@closeTab") {
        dispatch({ type: "tab/close", tabId: workspace.activeTabId });
        return;
      }
      if (command.type === "@clearSession") {
        if (session) dispatch({ type: "session/clear", sessionId: session.id });
        return;
      }
      dispatch(command);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, workspace.activeTabId, session]);

  return (
    <div className={styles.shell}>
      {/* A lone tab is not worth a row of chrome. */}
      {workspace.tabs.length > 1 && <TabStrip />}

      <main className={styles.body}>
        {tab && <PaneTree node={tab.root} activePaneId={tab.activePaneId} />}
      </main>

      <StatusBar />
    </div>
  );
}
