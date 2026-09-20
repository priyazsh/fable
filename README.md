# Forge

A native terminal for developers where AI agents are first-class citizens.

Forge is a real terminal first — a genuinely good one — with an agent runtime
built into it rather than bolted on. It is not a chatbot, not a browser IDE,
and not a shell wrapper with an AI button.

Target platforms are **Linux** and **Windows**.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 |
| Native core | Rust |
| Terminal UI | React 19 + TypeScript |
| Bundler | Vite 8 |
| Package manager | Bun |

## Development

```sh
bun install        # install frontend dependencies
bun run tauri:dev  # run the desktop app with hot reload
bun run typecheck  # tsc --noEmit
bun run tauri:build
```

Building on Linux requires `webkit2gtk-4.1` and its development headers.
AppImage bundling additionally needs `patchelf`.

### Layout

```
src/
  state/      workspace model (tabs, panes, sessions) + keybindings
  shell/      the visual shell: header, tabs, panes, agent rail, status bar
  platform/   typed wrappers over the Tauri IPC boundary
  styles/     design tokens and global styles
src-tauri/
  src/        the native core
```

Everything that crosses the IPC boundary lives in `src/platform`, so the UI
never calls `invoke` directly.

### Keybindings

| Chord | Action |
|---|---|
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Shift+W` | Close tab |
| `Ctrl+Shift+D` | Split pane right |
| `Ctrl+Shift+E` | Split pane down |
| `Ctrl+Shift+X` | Close pane |
| `Ctrl+1`…`Ctrl+9` | Switch to tab *n* |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+Shift+A` | Toggle agent panel |

## Status

| # | Milestone | State |
|---|---|---|
| 1 | Native Tauri application | ✅ |
| 2 | Forge visual shell | ✅ |
| 3 | xterm.js terminal renderer | — |
| 4 | Rust PTY / ConPTY integration | — |
| 5 | Fully functional shell | — |
| 6 | Tabs and panes | partial (layout done, sessions are placeholders) |
| 7 | Structured command blocks | — |
| 8 | Agent runtime | — |
| 9 | Claude Code integration | — |
| 10 | OpenAI integration | — |
| 11 | Agent tools | — |
| 12 | Permissions and checkpoints | — |
| 13 | Cross-platform CI / builds | — |

Panes currently render `src/shell/TerminalPlaceholder.tsx`, a static preview of
the command-block shape. Milestone 3 replaces that one component with the
xterm.js view; the tab/pane/session model around it is already real.
