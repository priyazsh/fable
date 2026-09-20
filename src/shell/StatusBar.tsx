import { useWorkspace } from "@/state/WorkspaceContext";
import { abbreviatePath, activeSessionOf, activeTabOf, collectLeaves } from "@/state/workspace";

import styles from "./StatusBar.module.css";

export function StatusBar() {
  const workspace = useWorkspace();
  const tab = activeTabOf(workspace);
  const session = activeSessionOf(workspace);
  const paneCount = tab ? collectLeaves(tab.root).length : 0;

  return (
    <footer className={styles.status}>
      <span className={styles.item}>{session?.title ?? "terminal"}</span>
      <span className={styles.divider} aria-hidden="true" />
      <span className={styles.item} title={session?.cwd}>
        {abbreviatePath(session?.cwd ?? "~", workspace.info?.home)}
      </span>
      {paneCount > 1 && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <span className={styles.item}>{paneCount} panes</span>
        </>
      )}

      <span className={styles.spacer} />

      <span className={styles.muted}>
        {workspace.info ? `${workspace.info.os}/${workspace.info.arch}` : "detecting…"}
      </span>
      <span className={styles.divider} aria-hidden="true" />
      <span className={styles.muted}>
        forge {workspace.info?.appVersion ?? "0.1.0"}
      </span>
    </footer>
  );
}
