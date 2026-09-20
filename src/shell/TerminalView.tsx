/**
 * One session: a timeline of commands and agent tasks, plus the single prompt
 * that feeds both.
 *
 * Milestone 4 replaces the command entry's output rendering with an xterm.js
 * surface. The timeline, prompt and routing stay as they are.
 */

import { useEffect, useLayoutEffect, useRef } from "react";

import { useWorkspace } from "@/state/WorkspaceContext";
import { entriesOf, type CommandEntry, type Session, type TaskEntry } from "@/state/workspace";

import { PromptInput } from "./PromptInput";
import { SettingsButton } from "./SettingsButton";
import styles from "./TerminalView.module.css";

/** Treat the view as "pinned" when the user is within this many px of the end. */
const STICK_THRESHOLD = 48;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function TerminalView({ session, focused }: { session: Session; focused: boolean }) {
  const workspace = useWorkspace();
  const entries = entriesOf(workspace, session);

  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance <= STICK_THRESHOLD;
  }

  // Follow streaming output, but only while the user has not scrolled away.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [workspace.entries, session.entryIds]);

  useEffect(() => {
    if (focused) promptRef.current?.focus();
  }, [focused]);

  return (
    <div
      className={styles.view}
      // Clicking dead space should land in the prompt, as in a real terminal.
      onMouseUp={(event) => {
        if (event.target === event.currentTarget || event.target === scrollRef.current) {
          promptRef.current?.focus();
        }
      }}
    >
      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
        {/* No welcome screen: a terminal opens to a prompt. Discovery lives in
            the status bar and in Settings, not in a wall of onboarding text. */}
        {entries.map((entry) =>
          entry.kind === "command" ? (
            <CommandRow key={entry.id} entry={entry} />
          ) : (
            <TaskRow key={entry.id} entry={entry} />
          ),
        )}

        {/* Inside the scrollback, not pinned below it: the prompt follows the
            last output the way a real shell prompt does. */}
        <PromptInput ref={promptRef} session={session} entries={entries} />
      </div>
    </div>
  );
}

function CommandRow({ entry }: { entry: CommandEntry }) {
  const failed = !entry.running && entry.exitCode !== 0;

  return (
    <article className={styles.entry}>
      <div className={styles.line}>
        <span className={styles.sigil}>$</span>
        <span className={styles.input}>{entry.input}</span>
        <span className={failed ? styles.metaFailed : styles.meta}>
          {entry.running ? (
            <span className={styles.running} aria-label="running" />
          ) : entry.exitCode === null ? (
            "terminated"
          ) : (
            <>
              {entry.exitCode !== 0 && `exit ${entry.exitCode} · `}
              {formatDuration(entry.durationMs ?? 0)}
            </>
          )}
        </span>
      </div>

      {entry.chunks.length > 0 && (
        <pre className={styles.output}>
          {entry.chunks.map((chunk, index) => (
            <span key={index} className={chunk.stream === "stderr" ? styles.stderr : undefined}>
              {chunk.text}
            </span>
          ))}
        </pre>
      )}
    </article>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function TaskRow({ entry }: { entry: TaskEntry }) {
  const lastStep = entry.steps[entry.steps.length - 1];
  const done = entry.steps.find((step) => step.kind === "done");
  const failed = Boolean(entry.error) || (done?.kind === "done" && done.isError);

  return (
    <article className={styles.entry}>
      <div className={styles.line}>
        <span className={styles.sigilAgent}>✦</span>
        <span className={styles.input}>{entry.input}</span>
        <span className={failed ? styles.metaFailed : styles.meta}>
          {entry.running ? (
            <span className={styles.runningAgent} aria-label="working" />
          ) : entry.durationMs !== null ? (
            formatDuration(entry.durationMs)
          ) : null}
        </span>
      </div>

      <div className={styles.steps}>
        {entry.steps.map((step, index) => {
          switch (step.kind) {
            case "started":
              return step.model ? (
                <p key={index} className={styles.stepMeta}>
                  {step.model}
                </p>
              ) : null;

            case "text":
              return (
                <p key={index} className={styles.response}>
                  {step.text}
                </p>
              );

            // Liveness, and only while it is the latest word.
            case "progress":
              return step === lastStep && entry.running ? (
                <p key={index} className={styles.stepMeta}>
                  working…
                  {step.tokens > 0 && ` ${formatTokens(step.tokens)} tokens`}
                </p>
              ) : null;

            case "done":
              return (
                <div key={index}>
                  {step.isError && step.result && (
                    <p className={styles.agentError}>{step.result}</p>
                  )}
                  {step.costUsd !== null && (
                    <p className={styles.stepMeta}>{formatCost(step.costUsd)}</p>
                  )}
                </div>
              );
          }
        })}

        {entry.error && (
          <p className={styles.agentError}>
            {entry.error} <SettingsButton focus="agent">Open settings</SettingsButton>
          </p>
        )}
      </div>
    </article>
  );
}
