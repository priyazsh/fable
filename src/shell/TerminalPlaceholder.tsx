/**
 * Static stand-in for the terminal view.
 *
 * This renders the command-block shape from the spec so the shell reads as a
 * terminal before a real PTY exists. Milestone 3 replaces this component with
 * the xterm.js view and Milestone 4 wires it to the PTY; nothing else in the
 * shell needs to change. `PaneTree` is its only importer.
 */

import { abbreviatePath } from "@/state/workspace";
import { useWorkspace } from "@/state/WorkspaceContext";

import styles from "./TerminalPlaceholder.module.css";

interface MockBlock {
  command: string;
  lines: string[];
  exitCode: number;
  duration: string;
}

const MOCK_BLOCKS: MockBlock[] = [
  {
    command: "bun run build",
    lines: ["compiling...", "✓ build complete"],
    exitCode: 0,
    duration: "4.2s",
  },
  {
    command: "bun run dev",
    lines: ["server started on localhost:3000"],
    exitCode: 0,
    duration: "0.4s",
  },
];

export function TerminalPlaceholder({ cwd }: { cwd: string }) {
  const workspace = useWorkspace();
  const shortCwd = abbreviatePath(cwd, workspace.info?.home);

  return (
    <div className={styles.viewport}>
      {MOCK_BLOCKS.map((block) => (
        <article key={block.command} className={styles.block}>
          <header className={styles.blockHeader}>
            <span className={styles.prompt}>$</span>
            <span className={styles.command}>{block.command}</span>
            <span className={block.exitCode === 0 ? styles.ok : styles.err}>
              {block.exitCode === 0 ? "✓" : `exit ${block.exitCode}`}
            </span>
            <span className={styles.duration}>{block.duration}</span>
          </header>
          <pre className={styles.output}>{block.lines.join("\n")}</pre>
        </article>
      ))}

      <div className={styles.live}>
        <span className={styles.cwd}>{shortCwd}</span>
        <span className={styles.prompt}>$</span>
        <span className={styles.cursor} aria-hidden="true" />
      </div>

      <p className={styles.note}>
        static preview — the PTY runtime arrives in milestone 4
      </p>
    </div>
  );
}
