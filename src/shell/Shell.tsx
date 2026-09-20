import { useEffect } from "react";

import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { isCloseTab, resolveBinding } from "@/state/keymap";
import { activeTabOf } from "@/state/workspace";

import { AgentPanel } from "./AgentPanel";
import { HeaderBar } from "./HeaderBar";
import { PaneTree } from "./PaneTree";
import { StatusBar } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import styles from "./Shell.module.css";

export function Shell() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const tab = activeTabOf(workspace);

  // A single window-level listener owns the shell's chords. Unmatched keys are
  // left alone so Milestone 5 can forward them to the focused terminal.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isCloseTab(event)) {
        event.preventDefault();
        dispatch({ type: "tab/close", tabId: workspace.activeTabId });
        return;
      }
      const binding = resolveBinding(event);
      if (!binding) return;
      event.preventDefault();
      dispatch(binding.action);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, workspace.activeTabId]);

  return (
    <div className={styles.shell}>
      <HeaderBar />
      <TabStrip />
      <div className={styles.body}>
        <main className={styles.panes}>
          {tab && <PaneTree node={tab.root} activePaneId={tab.activePaneId} />}
        </main>
        {workspace.agentPanelOpen && <AgentPanel />}
      </div>
      <StatusBar />
    </div>
  );
}
