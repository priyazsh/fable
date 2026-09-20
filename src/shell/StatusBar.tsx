import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { abbreviatePath, activeSessionOf, activeTabOf, collectLeaves } from "@/state/workspace";

import styles from "./StatusBar.module.css";

export function StatusBar() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const tab = activeTabOf(workspace);
  const session = activeSessionOf(workspace);
  const paneCount = tab ? collectLeaves(tab.root).length : 0;

  return (
    <footer className={styles.status}>
      <span className={styles.mark} aria-hidden="true">
        ✦
      </span>
      <span className={styles.cwd} title={session?.cwd}>
        {abbreviatePath(session?.cwd ?? "~", workspace.info?.home)}
      </span>

      {paneCount > 1 && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <span className={styles.muted}>{paneCount} panes</span>
        </>
      )}

      <span className={styles.spacer} />

      <span className={styles.muted}>
        {workspace.info ? `${workspace.info.os}/${workspace.info.arch}` : "detecting…"}
      </span>
      <span className={styles.divider} aria-hidden="true" />
      <span className={styles.muted}>forge {workspace.info?.appVersion ?? "0.1.0"}</span>

      <button
        type="button"
        className={styles.gear}
        onClick={() => dispatch({ type: "settings/toggle" })}
        aria-pressed={workspace.settingsOpen}
        title="Settings (Ctrl+,)"
        aria-label="Settings"
      >
        ⚙
      </button>
    </footer>
  );
}
