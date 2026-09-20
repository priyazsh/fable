/**
 * The single prompt.
 *
 * One input serves both the shell and the agent. The sigil and the hint on the
 * right show which one will receive the line, so the routing is visible before
 * Enter is pressed rather than a surprise afterwards.
 */

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { cachedCommand, ensureCommand } from "@/platform/shell";
import { classify, firstToken, splitForce } from "@/state/classify";
import { useSubmit } from "@/state/useSubmit";
import type { Entry, Session } from "@/state/workspace";

import styles from "./PromptInput.module.css";

/** Cap the growth of the box so a pasted file cannot swallow the timeline. */
const MAX_HEIGHT = 200;

interface PromptInputProps {
  ref: RefObject<HTMLTextAreaElement | null>;
  session: Session;
  entries: Entry[];
}

export function PromptInput({ ref, session, entries }: PromptInputProps) {
  const { submit, interrupt } = useSubmit();
  const [value, setValue] = useState("");
  const [draft, setDraft] = useState("");
  /** `null` while editing a fresh line, otherwise an index into history. */
  const [recalled, setRecalled] = useState<number | null>(null);
  const [probeTick, setProbeTick] = useState(0);

  // Probing PATH is async, so re-render once the answer for this token lands.
  useEffect(() => {
    const token = firstToken(splitForce(value).input);
    if (!token || cachedCommand(token) !== undefined) return;

    let alive = true;
    void ensureCommand(token).then(() => {
      if (alive) setProbeTick((tick) => tick + 1);
    });
    return () => {
      alive = false;
    };
  }, [value]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, ref]);

  // `probeTick` is a dependency in spirit: it exists to recompute this.
  void probeTick;
  const route = classify(value, cachedCommand);
  const asTask = route?.kind === "task";

  function recall(delta: number) {
    const { history } = session;
    if (history.length === 0) return;

    if (recalled === null) {
      if (delta > 0) return;
      setDraft(value);
      setRecalled(history.length - 1);
      setValue(history[history.length - 1]);
      return;
    }

    const next = recalled + delta;
    if (next < 0) return;
    if (next > history.length - 1) {
      setRecalled(null);
      setValue(draft);
      return;
    }
    setRecalled(next);
    setValue(history[next]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+C interrupts, unless there is a selection to copy.
    if (event.ctrlKey && event.code === "KeyC" && !window.getSelection()?.toString()) {
      if (interrupt(entries)) event.preventDefault();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!value.trim()) return;
      void submit(session, value);
      setValue("");
      setDraft("");
      setRecalled(null);
      return;
    }

    // Only navigate history from a single-line draft, so multi-line editing works.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !value.includes("\n")) {
      event.preventDefault();
      recall(event.key === "ArrowUp" ? -1 : 1);
    }
  }

  return (
    <div className={styles.prompt} data-route={asTask ? "task" : "command"}>
      <span className={asTask ? styles.sigilAgent : styles.sigil} aria-hidden="true">
        {asTask ? "✦" : "$"}
      </span>

      <textarea
        ref={ref}
        className={styles.input}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label="Command or task"
      />

      {value.trim() && (
        <span className={asTask ? styles.hintAgent : styles.hint}>
          ↵ {asTask ? "ask" : "run"}
        </span>
      )}
    </div>
  );
}
