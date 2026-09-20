/**
 * Settings.
 *
 * Only settings that actually take effect are offered. There is no API-key
 * field because the agent backend is the Claude Code CLI, which uses the
 * user's existing credentials.
 *
 * Every change round-trips through Rust and the UI adopts whatever Rust
 * returns, so a clamped or rejected value is reflected immediately.
 */

import { useEffect, useState } from "react";

import { agentAvailable } from "@/platform/agent";
import {
  availableShells,
  installedFonts,
  setSettings,
  settingsFile,
} from "@/platform/settings";
import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import type { AgentPermissions, Settings } from "@/state/workspace";

import styles from "./SettingsPanel.module.css";

const SYSTEM_FONT = "ui-monospace";
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

/**
 * Read-only is first and is the default: destructive access is never granted
 * implicitly (spec §11), and autonomy is an explicit opt-in (spec §13).
 */
const PERMISSION_CHOICES: { value: AgentPermissions; label: string; blurb: string }[] = [
  {
    value: "readOnly",
    label: "Read-only",
    blurb: "Inspects the workspace and plans. Cannot change or run anything.",
  },
  {
    value: "edits",
    label: "Edits",
    blurb: "May change files. Still cannot run commands.",
  },
  {
    value: "full",
    label: "Full",
    blurb: "May edit files and run commands without asking. Use deliberately.",
  },
];

const MODEL_CHOICES = ["opus", "sonnet", "haiku"];

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Last path segment, e.g. `/usr/bin/zsh` → `zsh`. */
function shellName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

export function SettingsPanel() {
  const { settings } = useWorkspace();
  const dispatch = useWorkspaceDispatch();

  const [shells, setShells] = useState<string[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentFound, setAgentFound] = useState<boolean | null>(null);

  useEffect(() => {
    setFonts(installedFonts());
    void availableShells().then(setShells);
    void settingsFile().then(setFilePath);
  }, []);

  // Re-probed whenever the binary setting changes.
  useEffect(() => {
    void agentAvailable().then(setAgentFound);
  }, [settings.agentBinary]);

  const close = () => dispatch({ type: "settings/close" });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "settings/close" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  async function update(patch: Partial<Settings>) {
    try {
      const saved = await setSettings({ ...settings, ...patch });
      dispatch({ type: "settings/loaded", settings: saved });
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button type="button" className={styles.close} onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>Font</span>
            <select
              className={styles.control}
              value={settings.fontFamily}
              onChange={(event) => void update({ fontFamily: event.currentTarget.value })}
            >
              <option value={SYSTEM_FONT}>System default</option>
              {fonts.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Size</span>
            <span className={styles.sizeRow}>
              <input
                className={styles.range}
                type="range"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                step={1}
                value={settings.fontSize}
                onChange={(event) =>
                  void update({ fontSize: Number(event.currentTarget.value) })
                }
              />
              <span className={styles.sizeValue}>{settings.fontSize} px</span>
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Shell</span>
            <select
              className={styles.control}
              value={settings.shell ?? ""}
              onChange={(event) =>
                void update({ shell: event.currentTarget.value || null })
              }
            >
              <option value="">Default ($SHELL)</option>
              {shells.map((path) => (
                <option key={path} value={path}>
                  {shellName(path)} — {path}
                </option>
              ))}
            </select>
          </label>

          <fieldset className={styles.field}>
            <legend className={styles.label}>New tabs</legend>
            <div className={styles.radios}>
              {(
                [
                  ["cwd", "Launch directory"],
                  ["home", "Home directory"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={styles.radio}>
                  <input
                    type="radio"
                    name="newTabCwd"
                    value={value}
                    checked={settings.newTabCwd === value}
                    onChange={() => void update({ newTabCwd: value })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <hr className={styles.rule} />

          <fieldset className={styles.field}>
            <legend className={styles.label}>Agent can</legend>
            <div className={styles.stack}>
              <select
                className={styles.control}
                value={settings.agentPermissions}
                onChange={(event) =>
                  void update({
                    agentPermissions: event.currentTarget.value as AgentPermissions,
                  })
                }
              >
                {PERMISSION_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <p className={styles.blurb}>
                {
                  PERMISSION_CHOICES.find(
                    (choice) => choice.value === settings.agentPermissions,
                  )?.blurb
                }
              </p>
            </div>
          </fieldset>

          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            <select
              className={styles.control}
              value={settings.agentModel ?? ""}
              onChange={(event) =>
                void update({ agentModel: event.currentTarget.value || null })
              }
            >
              <option value="">Default</option>
              {MODEL_CHOICES.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>

        {agentFound === false && (
          <p className={styles.warning}>
            Claude Code was not found on PATH. Install it to use the agent — no API
            key is needed, it signs in with your existing account.
          </p>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <footer className={styles.footer}>
          {filePath ? (
            <>
              stored in <span className={styles.path}>{filePath}</span>
            </>
          ) : (
            "settings are not persisted outside the desktop app"
          )}
        </footer>
      </div>
    </div>
  );
}
