import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { useWorkspace, useWorkspaceDispatch } from "@/state/WorkspaceContext";
import type { PaneId, PaneNode } from "@/state/workspace";

import { TerminalPlaceholder } from "./TerminalPlaceholder";
import styles from "./PaneTree.module.css";

/** Smallest fraction a pane may be dragged down to. */
const MIN_FRACTION = 0.12;

interface PaneTreeProps {
  node: PaneNode;
  activePaneId: PaneId;
}

export function PaneTree({ node, activePaneId }: PaneTreeProps) {
  if (node.kind === "leaf") {
    return <Pane paneId={node.id} sessionId={node.sessionId} active={node.id === activePaneId} />;
  }
  return <Split node={node} activePaneId={activePaneId} />;
}

function Pane({
  paneId,
  sessionId,
  active,
}: {
  paneId: PaneId;
  sessionId: string;
  active: boolean;
}) {
  const workspace = useWorkspace();
  const dispatch = useWorkspaceDispatch();
  const session = workspace.sessions[sessionId];

  return (
    <section
      className={active ? styles.paneActive : styles.pane}
      onMouseDown={() => dispatch({ type: "pane/focus", paneId })}
      aria-label={session?.title ?? "terminal"}
    >
      {/* Milestone 3 replaces this with the xterm.js view. */}
      <TerminalPlaceholder cwd={session?.cwd ?? "~"} />
    </section>
  );
}

function Split({
  node,
  activePaneId,
}: {
  node: Extract<PaneNode, { kind: "split" }>;
  activePaneId: PaneId;
}) {
  const dispatch = useWorkspaceDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const horizontal = node.direction === "row";

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;

    const offset = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const first = Math.min(Math.max(offset / total, MIN_FRACTION), 1 - MIN_FRACTION);
    dispatch({ type: "pane/resize", nodeId: node.id, sizes: [first, 1 - first] });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div
      ref={containerRef}
      className={horizontal ? styles.splitRow : styles.splitColumn}
      data-direction={node.direction}
    >
      <div className={styles.slot} style={{ flexBasis: `${node.sizes[0] * 100}%` }}>
        <PaneTree node={node.children[0]} activePaneId={activePaneId} />
      </div>

      <div
        className={horizontal ? styles.gutterRow : styles.gutterColumn}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      <div className={styles.slot} style={{ flexBasis: `${node.sizes[1] * 100}%` }}>
        <PaneTree node={node.children[1]} activePaneId={activePaneId} />
      </div>
    </div>
  );
}
