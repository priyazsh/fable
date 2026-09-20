import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { collectLeaves } from "@/state/workspace";

import styles from "./TabStrip.module.css";

export function TabStrip() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();

  return (
    <nav className={styles.strip} aria-label="Terminal tabs">
      <ul className={styles.tabs} role="tablist">
        {workspace.tabs.map((tab) => {
          const active = tab.id === workspace.activeTabId;
          const paneCount = collectLeaves(tab.root).length;
          return (
            <li key={tab.id} className={active ? styles.tabActive : styles.tab}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={styles.label}
                onClick={() => dispatch({ type: "tab/activate", tabId: tab.id })}
              >
                {tab.title}
                {paneCount > 1 && <span className={styles.paneCount}>{paneCount}</span>}
              </button>
              <button
                type="button"
                className={styles.close}
                title="Close tab (Ctrl+Shift+W)"
                aria-label={`Close ${tab.title}`}
                onClick={() => dispatch({ type: "tab/close", tabId: tab.id })}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className={styles.add}
        title="New tab (Ctrl+Shift+T)"
        aria-label="New tab"
        onClick={() => dispatch({ type: "tab/open" })}
      >
        +
      </button>
    </nav>
  );
}
