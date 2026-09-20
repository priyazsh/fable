# Forge

A native terminal for developers where AI agents are first-class citizens.

Forge is a real terminal first — a genuinely good one — with an agent runtime
built into it rather than bolted on. It is not a chatbot, not a browser IDE,
and not a shell wrapper with an AI button.

Target platforms are **Linux** and **Windows**.

## One prompt, two destinations

There is a single input line. Forge routes it:

```
$ git status                 → runs in the shell
✦ fix the failing auth test  → handed to the agent
```

The rule is first-token-only and deliberately dumb: if the leading word is a
shell builtin, a path, a `VAR=` assignment or resolves on `PATH`, the line runs;
otherwise it becomes an agent task. Because a clever classifier that is
unpredictably wrong is worse than a simple one that is visibly wrong, the
prompt shows the decision — sigil and `↵ run` / `↵ ask` — *before* you press
Enter, and two prefixes override it:

| Prefix | Effect |
|---|---|
| `!` | force the shell (`!make the thing`) |
| `?` | force the agent (`?git status`) |

## The agent

The `✦` branch sends the line to an LLM provider over HTTPS. Bring your own
key — it is stored in your **OS keyring** (Secret Service, Credential Manager,
Keychain), never in Forge's config file, and never in frontend state.

| Provider | Models | Key from |
|---|---|---|
| Anthropic (default) | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5-1` | console.anthropic.com |
| OpenAI | fetched from your account's `/v1/models` | platform.openai.com |

Set it in Settings (`Ctrl+,`). Each provider translates its own wire format
into one small neutral step vocabulary, so nothing above `src-tauri/src/providers`
knows either vendor's schema (spec §9).

**What the agent can and cannot do.** There is no tool loop yet (milestone 11),
so it cannot read files, edit them, or run commands. The system prompt says so
explicitly, and gives it targeted context — working directory, platform,
detected project type, git branch — so its advice is grounded and it returns
exact commands rather than pretending to have acted.

Reasoning is never displayed. Thinking blocks are discarded in the Rust
translation layer before they can reach the UI (spec §12); only prose, a
progress indicator and the final cost are surfaced.

## Stack

### Layout

```
src/
  state/      workspace model (tabs, panes, sessions, timeline), routing, keymap
  shell/      the visual shell: tabs, panes, timeline, prompt, status bar
  platform/   typed wrappers over the Tauri IPC boundary
  styles/     design tokens and global styles
src-tauri/
  src/
    workspace.rs   environment snapshot, project detection
    shell.rs       command execution and streaming
    agent.rs       the agent runtime and step vocabulary
    secrets.rs     API keys, via the OS keyring
    providers/     anthropic, openai, and shared SSE framing
```

Everything that crosses the IPC boundary lives in `src/platform`, so the UI
never calls `invoke` directly and still renders in a plain browser.

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
| `Ctrl+L` | Clear the session |
| `Ctrl+,` | Settings |
| `Ctrl+C` | Interrupt the running command |
| `↑` / `↓` | Recall history |

The tab strip only appears once a second tab exists, so a single session has no
chrome above the timeline at all.

## Status

| # | Milestone | State |
|---|---|---|
| 1 | Native Tauri application | ✅ |
| 2 | Forge visual shell | ✅ |
| 3 | xterm.js terminal renderer | — |
| 4 | Rust PTY / ConPTY integration | — |
| 5 | Fully functional shell | partial (see below) |
| 6 | Tabs and panes | ✅ layout; sessions are not yet PTY-backed |
| 7 | Structured command blocks | ✅ shape; fed by one-shot execution |
| 8 | Agent runtime | ✅ streaming, provider-neutral steps |
| 9 | Anthropic integration | ✅ |
| 10 | OpenAI integration | ✅ |
| 11 | Agent tools | — (the agent advises; it cannot act) |
| 12 | Permissions and checkpoints | — |
| 13 | Cross-platform CI / builds | — |

### What "partial" means for execution

Commands run for real, through your `$SHELL -c` (`cmd /C` on Windows), with
stdout and stderr streamed back live and a real exit code and duration. What
does **not** work yet, because there is no PTY:

- interactive programs — `vim`, `htop`, `ssh`, `top`
- anything that needs a TTY to decide on colour or line-editing
- `stdin` is `/dev/null`, so prompts get EOF rather than hanging
- `Ctrl+C` signals the shell process, not its process group

`cd` is applied to the session rather than a child process, since one-shot
execution has no persistent shell to hold it.

Milestone 4 replaces the spawning in `src-tauri/src/shell.rs` with a real
PTY/ConPTY behind the same event shape, so the timeline and routing do not
change.
