/**
 * Turns a submitted prompt line into a timeline entry.
 *
 * This is where the single input splits: shell commands are spawned through
 * the Rust runner, everything else becomes an agent task.
 */

import { useCallback } from "react";

import { killAgent, runAgentTask } from "@/platform/agent";
import { ensureCommand, cachedCommand, killCommand, resolveDir, runCommand } from "@/platform/shell";

import { classify, parseCd } from "./classify";
import { useWorkspaceDispatch } from "./WorkspaceContext";
import type { CommandEntry, Entry, Session, TaskEntry } from "./workspace";

function newEntryId(): string {
  return crypto.randomUUID?.() ?? `entry-${Math.random().toString(36).slice(2)}`;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useSubmit() {
  const dispatch = useWorkspaceDispatch();

  const submit = useCallback(
    async (session: Session, raw: string) => {
      let route = classify(raw, cachedCommand);
      if (!route) return;

      // The first token has not been probed against PATH yet.
      if (route.kind === "unknown") {
        await ensureCommand(route.program);
        route = classify(raw, cachedCommand);
        if (!route || route.kind === "unknown") return;
      }

      const id = newEntryId();

      if (route.kind === "task") {
        const entry: TaskEntry = {
          id,
          kind: "task",
          input: route.input,
          cwd: session.cwd,
          steps: [],
          running: true,
          error: null,
          durationMs: null,
        };
        dispatch({ type: "entry/start", sessionId: session.id, entry });
        try {
          await runAgentTask(id, route.input, session.cwd);
        } catch (error) {
          dispatch({ type: "entry/agentFailed", entryId: id, message: messageOf(error) });
        }
        return;
      }

      const entry: CommandEntry = {
        id,
        kind: "command",
        input: route.input,
        cwd: session.cwd,
        chunks: [],
        exitCode: null,
        durationMs: null,
        running: true,
      };
      dispatch({ type: "entry/start", sessionId: session.id, entry });

      const fail = (message: string, exitCode: number) => {
        dispatch({ type: "entry/output", entryId: id, stream: "stderr", text: `${message}\n` });
        dispatch({ type: "entry/exit", entryId: id, exitCode, durationMs: 0 });
      };

      // One-shot execution has no persistent shell, so `cd` is applied to the
      // session instead of a child process.
      const cd = parseCd(route.input);
      if (cd) {
        try {
          const cwd = await resolveDir(session.cwd, cd.target);
          dispatch({ type: "session/cwd", sessionId: session.id, cwd });
          dispatch({ type: "entry/exit", entryId: id, exitCode: 0, durationMs: 0 });
        } catch (error) {
          fail(messageOf(error), 1);
        }
        return;
      }

      try {
        await runCommand(id, route.input, session.cwd);
      } catch (error) {
        fail(messageOf(error), 127);
      }
    },
    [dispatch],
  );

  /**
   * Kills the most recent still-running command or agent task. Returns whether
   * there was anything to interrupt, so the caller knows to swallow Ctrl+C.
   */
  const interrupt = useCallback((entries: Entry[]): boolean => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry.running) continue;
      if (entry.kind === "command") {
        void killCommand(entry.id);
      } else {
        void killAgent(entry.id);
      }
      return true;
    }
    return false;
  }, []);

  return { submit, interrupt };
}
