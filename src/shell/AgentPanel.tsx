/**
 * Agent rail.
 *
 * The agent runtime lands in Milestone 8. Until then this panel shows the
 * shell's real state (workspace + keybindings) rather than fake conversation,
 * and stays collapsible so Forge is fully usable with AI off (spec §6).
 */

import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import { SHORTCUT_HELP } from "@/state/keymap";
import { abbreviatePath, activeSessionOf, collectLeaves } from "@/state/workspace";

import styles from "./AgentPanel.module.css";

export function AgentPanel() {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const session = activeSessionOf(workspace);
  const paneCount = workspace.tabs.reduce(
    (total, tab) => total + collectLeaves(tab.root).length,
    0,
  );

  return (
    <aside className={styles.panel} aria-label="Agent">
      <header className={styles.header}>
        <span className={styles.title}>
          <span className={styles.mark} aria-hidden="true">
            ✦
          </span>
          Agent
        </span>
        <button
          type="button"
          className={styles.collapse}
          onClick={() => dispatch({ type: "agent/toggle" })}
          title="Hide agent panel (Ctrl+Shift+A)"
          aria-label="Hide agent panel"
        >
          ✕
        </button>
      </header>

      <div className={styles.body}>
        <p className={styles.idle}>
          No agent provider configured. Claude Code and OpenAI backends arrive in
          milestones 9 and 10.
        </p>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Workspace</h2>
          <dl className={styles.facts}>
            <dt>directory</dt>
            <dd title={session?.cwd}>
              {abbreviatePath(session?.cwd ?? "~", workspace.info?.home)}
            </dd>
            <dt>platform</dt>
            <dd>
              {workspace.info ? `${workspace.info.os}/${workspace.info.arch}` : "—"}
            </dd>
            <dt>sessions</dt>
            <dd>
              {paneCount} in {workspace.tabs.length} tab
              {workspace.tabs.length === 1 ? "" : "s"}
            </dd>
          </dl>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Shortcuts</h2>
          <ul className={styles.shortcuts}>
            {SHORTCUT_HELP.map((shortcut) => (
              <li key={shortcut.chord}>
                <span>{shortcut.label}</span>
                <kbd className={styles.kbd}>{shortcut.chord}</kbd>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
