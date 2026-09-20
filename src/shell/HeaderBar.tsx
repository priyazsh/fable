import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { abbreviatePath, activeSessionOf } from "@/state/workspace";

import styles from "./HeaderBar.module.css";

export function HeaderBar() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const session = activeSessionOf(workspace);
  const cwd = abbreviatePath(session?.cwd ?? "~", workspace.info?.home);

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          ✦
        </span>
        <span className={styles.name}>Forge</span>
      </div>

      <div className={styles.cwd} title={session?.cwd}>
        {cwd}
      </div>

      <button
        type="button"
        className={styles.agentToggle}
        onClick={() => dispatch({ type: "agent/toggle" })}
        aria-pressed={workspace.agentPanelOpen}
        title="Toggle agent panel (Ctrl+Shift+A)"
      >
        <span
          className={workspace.agentPanelOpen ? styles.dotOn : styles.dotOff}
          aria-hidden="true"
        />
        agent
      </button>
    </header>
  );
}
