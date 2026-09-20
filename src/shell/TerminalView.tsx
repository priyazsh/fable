/**
 * One session: a timeline of commands and agent tasks, plus the single prompt
 * that feeds both.
 *
 * Milestone 4 replaces the command entry's output rendering with an xterm.js
 * surface. The timeline, prompt and routing stay as they are.
 */

import { useEffect, useLayoutEffect, useRef } from "react";

import { useWorkspace } from "@/state/WorkspaceContext";
import { SHORTCUT_HELP } from "@/state/keymap";
import { entriesOf, type CommandEntry, type Session, type TaskEntry } from "@/state/workspace";

import { PromptInput } from "./PromptInput";
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
        {entries.length === 0 ? (
          <EmptyState />
        ) : (
          entries.map((entry) =>
            entry.kind === "command" ? (
              <CommandRow key={entry.id} entry={entry} />
            ) : (
              <TaskRow key={entry.id} entry={entry} />
            ),
          )
        )}
      </div>

      <PromptInput ref={promptRef} session={session} entries={entries} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyLead}>
        Type a command to run it, or describe a task to hand it to the agent.
      </p>
      <p className={styles.emptyNote}>
        <kbd className={styles.kbd}>!</kbd> forces the shell,{" "}
        <kbd className={styles.kbd}>?</kbd> forces the agent. The agent starts read-only —
        raise what it may do in Settings. Interactive programs need the PTY, which
        arrives in milestone 4.
      </p>
      <ul className={styles.emptyShortcuts}>
        {SHORTCUT_HELP.map((shortcut) => (
          <li key={shortcut.chord}>
            <kbd className={styles.kbd}>{shortcut.chord}</kbd>
            <span>{shortcut.label}</span>
          </li>
        ))}
      </ul>
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
            <span
              key={index}
              className={chunk.stream === "stderr" ? styles.stderr : undefined}
            >
              {chunk.text}
            </span>
          ))}
        </pre>
      )}
    </article>
  );
}

/** Present-tense verbs for the tools the agent reports using. */
const TOOL_VERBS: Record<string, string> = {
  Read: "reading",
  Edit: "editing",
  Write: "writing",
  NotebookEdit: "editing",
  Bash: "running",
  BashOutput: "running",
  Grep: "searching",
  Glob: "searching",
  Task: "delegating",
  Agent: "delegating",
  WebFetch: "fetching",
  WebSearch: "searching",
  Skill: "using",
  TodoWrite: "planning",
};

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function TaskRow({ entry }: { entry: TaskEntry }) {
  const lastStep = entry.steps[entry.steps.length - 1];
  const done = entry.steps.find((step) => step.kind === "done");
  const spoke = entry.steps.some((step) => step.kind === "text");
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
              return (
                <p key={index} className={styles.stepMeta}>
                  {[step.model, step.permissionMode].filter(Boolean).join(" · ")}
                </p>
              );

            case "tool":
              return (
                <p key={index} className={styles.stepTool}>
                  <span className={styles.stepArrow} aria-hidden="true">
                    ›
                  </span>
                  {TOOL_VERBS[step.name] ?? step.name.toLowerCase()}
                  {step.detail && <span className={styles.stepDetail}>{step.detail}</span>}
                </p>
              );

            case "text":
              return (
                <p key={index} className={styles.response}>
                  {step.text}
                </p>
              );

            case "notice":
              return (
                <p key={index} className={styles.stepNotice}>
                  {step.text}
                </p>
              );

            // Progress is liveness only, and only while it is the latest word.
            case "progress":
              return step === lastStep && entry.running ? (
                <p key={index} className={styles.stepMeta}>
                  working… {formatTokens(step.tokens)} tokens
                </p>
              ) : null;

            case "done":
              return (
                <div key={index}>
                  {/* The result repeats the last message unless the agent
                      never spoke, in which case it is all we have. */}
                  {!spoke && step.result && (
                    <p className={step.isError ? styles.agentError : styles.response}>
                      {step.result}
                    </p>
                  )}
                  {step.denials > 0 && (
                    <p className={styles.stepNotice}>
                      {step.denials} action{step.denials === 1 ? " was" : "s were"} blocked by
                      the current permission level — change it in Settings (Ctrl+,).
                    </p>
                  )}
                  <p className={styles.stepMeta}>
                    {[
                      step.turns !== null && `${step.turns} turn${step.turns === 1 ? "" : "s"}`,
                      step.costUsd !== null && formatCost(step.costUsd),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              );
          }
        })}

        {entry.error && <p className={styles.agentError}>{entry.error}</p>}
      </div>
    </article>
  );
}
