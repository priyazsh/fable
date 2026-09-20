/**
 * Input routing.
 *
 * A single prompt accepts both shell commands and agent tasks, so every line
 * has to be routed. The rule is deliberately dumb and first-token-only:
 *
 *   - `!…` always runs in the shell, `?…` always goes to the agent
 *   - a path-like, `$`-prefixed or `VAR=…` first token is a command
 *   - otherwise the first token is a command if it resolves on PATH or is a
 *     shell builtin
 *   - everything else is a task
 *
 * A clever classifier that is unpredictably wrong is worse than a simple one
 * that is visibly wrong, so the prompt renders the decision live before Enter
 * is pressed and the `!` / `?` prefixes let the user override it.
 */

export type Route =
  /** Run it. */
  | { kind: "command"; input: string; program: string }
  /** Hand it to the agent. */
  | { kind: "task"; input: string }
  /** First token not probed yet; the caller must resolve it and retry. */
  | { kind: "unknown"; input: string; program: string };

/** Result of peeling off an explicit `!` or `?` override. */
export function splitForce(raw: string): {
  forced: "command" | "task" | null;
  input: string;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("!")) return { forced: "command", input: trimmed.slice(1).trim() };
  if (trimmed.startsWith("?")) return { forced: "task", input: trimmed.slice(1).trim() };
  return { forced: null, input: trimmed };
}

export function firstToken(input: string): string {
  return input.trimStart().split(/\s+/, 1)[0] ?? "";
}

/** Tokens that are commands regardless of PATH. */
function looksLikeInvocation(token: string): boolean {
  return (
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~/") ||
    token.startsWith("$") ||
    token.includes("/") ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  );
}

/**
 * Routes one line. `known` reports whether a program exists, or `undefined`
 * when it has not been probed yet.
 */
export function classify(
  raw: string,
  known: (program: string) => boolean | undefined,
): Route | null {
  const { forced, input } = splitForce(raw);
  if (!input) return null;

  const program = firstToken(input);
  if (forced === "command") return { kind: "command", input, program };
  if (forced === "task") return { kind: "task", input };
  if (looksLikeInvocation(program)) return { kind: "command", input, program };

  const exists = known(program);
  if (exists === undefined) return { kind: "unknown", input, program };
  return exists ? { kind: "command", input, program } : { kind: "task", input };
}

/** `cd` has no persistent shell to live in, so the session tracks it instead. */
const CD_PATTERN = /^cd(?:\s+([^|&;<>()`$]*))?$/;

/**
 * Returns the `cd` target when `input` is a plain directory change, or `null`.
 * Anything with shell operators in it is left to the shell.
 */
export function parseCd(input: string): { target: string | undefined } | null {
  const match = CD_PATTERN.exec(input.trim());
  if (!match) return null;
  const raw = match[1]?.trim();
  if (!raw) return { target: undefined };
  const unquoted = /^(["'])(.*)\1$/.exec(raw);
  return { target: unquoted ? unquoted[2] : raw };
}
