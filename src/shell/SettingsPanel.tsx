/**
 * Settings.
 *
 * Only settings that actually take effect are offered. API keys are written
 * straight to the OS keyring through Rust and never enter frontend state —
 * the UI only ever learns whether one exists.
 *
 * Every other change round-trips through Rust and the UI adopts whatever Rust
 * returns, so a clamped or rejected value is reflected immediately.
 */

import { useEffect, useRef, useState } from "react";

import { clearApiKey, hasApiKey, listModels, setApiKey } from "@/platform/agent";
import { availableShells, installedFonts, setSettings, settingsFile } from "@/platform/settings";
import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import type { Provider, Settings } from "@/state/workspace";

import styles from "./SettingsPanel.module.css";

const SYSTEM_FONT = "ui-monospace";
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

const PROVIDERS: { value: Provider; label: string; keyHint: string; console: string }[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    keyHint: "sk-ant-…",
    console: "console.anthropic.com",
  },
  {
    value: "openai",
    label: "OpenAI",
    keyHint: "sk-…",
    console: "platform.openai.com",
  },
];

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
  const { settings, settingsFocus } = useWorkspace();
  const dispatch = useWorkspaceDispatch();

  const [shells, setShells] = useState<string[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [keyStored, setKeyStored] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const providerRef = useRef<HTMLSelectElement>(null);
  const provider = PROVIDERS.find((entry) => entry.value === settings.provider) ?? PROVIDERS[0];

  useEffect(() => {
    setFonts(installedFonts());
    void availableShells().then(setShells);
    void settingsFile().then(setFilePath);
  }, []);

  // Key presence and the model list are both provider-scoped.
  useEffect(() => {
    let alive = true;
    setKeyDraft("");
    setModelsError(null);
    void hasApiKey(settings.provider).then((stored) => alive && setKeyStored(stored));
    listModels(settings.provider)
      .then((list) => alive && setModels(list))
      .catch((cause) => {
        if (!alive) return;
        setModels([]);
        setModelsError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [settings.provider, keyStored]);

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

  // Opened from agent friction: land on the control that fixes it.
  useEffect(() => {
    if (settingsFocus === "agent") providerRef.current?.focus();
  }, [settingsFocus]);

  async function update(patch: Partial<Settings>) {
    try {
      const saved = await setSettings({ ...settings, ...patch });
      dispatch({ type: "settings/loaded", settings: saved });
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function saveKey() {
    try {
      await setApiKey(settings.provider, keyDraft);
      setKeyDraft("");
      setKeyStored(true);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function removeKey() {
    try {
      await clearApiKey(settings.provider);
      setKeyStored(false);
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
              onChange={(event) => void update({ shell: event.currentTarget.value || null })}
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

          <label
            className={settingsFocus === "agent" ? styles.fieldHighlighted : styles.field}
          >
            <span className={styles.label}>Agent</span>
            <select
              ref={providerRef}
              className={styles.control}
              value={settings.provider}
              onChange={(event) =>
                void update({
                  provider: event.currentTarget.value as Provider,
                  // Models do not carry across providers.
                  agentModel: null,
                })
              }
            >
              {PROVIDERS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>API key</span>
            <div className={styles.stack}>
              <div className={styles.keyRow}>
                <input
                  className={styles.control}
                  type="password"
                  value={keyDraft}
                  placeholder={keyStored ? "•••••••••••• stored" : provider.keyHint}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setKeyDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && keyDraft.trim()) {
                      event.preventDefault();
                      void saveKey();
                    }
                  }}
                  aria-label={`${provider.label} API key`}
                />
                {keyDraft.trim() ? (
                  <button type="button" className={styles.keyAction} onClick={() => void saveKey()}>
                    Save
                  </button>
                ) : (
                  keyStored && (
                    <button
                      type="button"
                      className={styles.keyAction}
                      onClick={() => void removeKey()}
                    >
                      Clear
                    </button>
                  )
                )}
              </div>
              <p className={styles.blurb}>
                {keyStored
                  ? `Stored in your OS keyring, not in Forge's config file.`
                  : `Create one at ${provider.console}. It goes to your OS keyring.`}
              </p>
            </div>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            <div className={styles.stack}>
              <select
                className={styles.control}
                value={settings.agentModel ?? ""}
                disabled={models.length === 0}
                onChange={(event) =>
                  void update({ agentModel: event.currentTarget.value || null })
                }
              >
                <option value="">
                  {settings.provider === "anthropic" ? "Default" : "Choose a model"}
                </option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              {modelsError && <p className={styles.blurb}>{modelsError}</p>}
            </div>
          </label>
        </div>

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
