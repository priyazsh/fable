/**
 * Inline "open settings" affordance.
 *
 * Shown at the points where the agent is actually blocked by configuration,
 * so the fix is one click away rather than a keyboard shortcut the user has
 * to know about.
 */

import { useWorkspaceDispatch } from "@/state/WorkspaceContext";
import type { SettingsFocus } from "@/state/workspace";

import styles from "./SettingsButton.module.css";

export function SettingsButton({
  children,
  focus,
}: {
  children: React.ReactNode;
  focus?: SettingsFocus;
}) {
  const dispatch = useWorkspaceDispatch();
  return (
    <button
      type="button"
      className={styles.button}
      onClick={() => dispatch({ type: "settings/open", focus })}
    >
      <span className={styles.gear} aria-hidden="true">
        ⚙
      </span>
      {children}
    </button>
  );
}
