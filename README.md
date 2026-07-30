# ATController

ATController is a native macOS control plane for local Codex sessions. It gives the official, locally installed Codex runtime a focused graphical interface for projects, threads, turns, commands, file changes, approvals, models, usage, and recovery.

Codex is the only runtime. The normal conversation path uses the structured `codex app-server` protocol over stdio; it does not scrape terminal output or simulate keystrokes.

## Product experience

ATController is organized around a resizable three-region workspace:

- Persistent project shelves with each project’s active, recent, and archived Codex threads nested beneath it.
- A structured conversation timeline for user messages, streamed agent responses, reasoning summaries, plans, commands, file edits, tool calls, approvals, errors, and completion.
- An optional inspector for Git changes, command history, thread details, and runtime health.

The compact composer supports multiline prompts, prompt history, file and image attachments, drag and drop, pasted images, runtime skills, turn steering, interruption, model and reasoning selection, permission modes, and the Codex-reported five-hour and weekly usage windows.

The resizable **Project Terminal** is a separate utility shelf at the bottom of the ATController window. It runs a native login shell in the selected project and is never used as the primary Codex conversation renderer. The explicit **Open Resume Command in Terminal** action remains a Terminal.app handoff so a Codex session can be resumed outside ATController.

### Project shelves

Projects are the primary navigation unit. Each shelf represents one canonical local directory and retains its display name, icon, pin state, custom order, and expanded state. An expanded shelf exposes a project-scoped **New thread** action followed by running and recent threads; archived threads remain behind a reversible **Show archived / Hide archived** disclosure.

The sidebar’s top actions, project context menus, command palette, and lightweight project manager support:

- opening a local folder with the native macOS picker;
- importing workspaces discovered from official Codex thread history without copying transcripts;
- cloning a repository with argument-safe Git execution;
- expanding, collapsing, sorting, reordering, pinning, renaming, and managing projects;
- locating a moved folder or removing only the ATController project entry.

The compact **New thread** and **Open folder** actions sit directly beneath the ATController header. Less frequent import, clone, sorting, expansion, and management actions remain keyboard-accessible through the command palette instead of occupying a wide header popover.

Paths are canonicalized before duplicate detection, including symlink resolution. Missing folders remain visible with recovery actions. Project removal never deletes the directory, repository, files, or Codex threads.

The unified sidebar search matches project names and paths plus thread titles, previews, and canonical IDs while retaining project context. Several shelves can show running, approval, failure, and unread state at the same time.

## Requirements

- Apple silicon Mac running macOS 12 or newer
- Node.js 20.19+ or 22.12+ and Yarn Classic 1.22 for development
- Rust 1.88+ and Xcode Command Line Tools for native builds
- The official Codex CLI installed and authenticated
- A Codex CLI version that supports `app-server --stdio`, `generate-ts`, and `generate-json-schema`
- For optional browser automation: Node.js, `npx`, and Chrome/Chromium or a Playwright-managed browser

Install and authenticate Codex:

```bash
npm install --global @openai/codex
codex login
codex login status
```

ATController discovers Codex through its configured binary override, the application environment, standard installation paths, and the login-shell environment. Authentication remains entirely managed by Codex.

## Install ATController

Production releases publish exactly:

- [ATController.dmg](https://github.com/FuRyanf/ATController/releases/latest/download/ATController.dmg)
- [ATController.app.zip](https://github.com/FuRyanf/ATController/releases/latest/download/ATController.app.zip)

Open `ATController.dmg` and drag `ATController.app` to Applications. Tagged production releases are Developer ID signed, notarized, and stapled. Branch and pull-request builds are unsigned development artifacts.

## Architecture

```text
ATController React UI
        ↕ typed Tauri commands and events
Rust Codex app-server client
        ↕ JSON RPC messages over JSONL stdio
codex app-server --stdio
        ↕
Official Codex runtime
```

Browser automation stays on the same structured runtime path:

```text
ATController browser UI
        ↕ typed Tauri commands and normalized events
codex app-server
        ↕ structured MCP calls and results
Playwright MCP
        ↕
isolated headed browser
```

The Rust layer owns process discovery, startup, initialization, request correlation, streaming, approvals, diagnostics, restart supervision, and shutdown. React receives a narrow ATController domain model rather than importing raw generated protocol types.

Every connection performs this lifecycle exactly once:

1. Spawn the resolved binary with the argument array `["app-server", "--stdio"]`.
2. Send `initialize` with ATController client metadata and stable capabilities.
3. Wait for a successful response.
4. Send the required `initialized` notification.
5. Allow normal requests and structured event delivery.

The checked-in protocol bindings and JSON Schema in `generated/codex-app-server/` were generated by the installed Codex CLI and are the compatibility source of truth. Experimental APIs are disabled.

See [technology.md](technology.md) for transport, state, normalization, and supervision details.

## Getting started

1. Launch ATController.
2. Choose **Open Folder** and select a local directory, or import projects from existing Codex history.
3. Select an existing Codex thread or create a new thread.
4. Enter a task and press Return.
5. Follow structured activity in the timeline.
6. Review commands and changes inline or in the inspector.
7. Respond to an approval when Standard or Workspace Access requires one.
8. Continue, steer, interrupt, rename, fork, archive, or resume the thread.

Threads are listed and read through Codex. ATController persists only project definitions and useful UI metadata such as pinned/unread state, drafts, prompt history, selected settings, panel state, and last-viewed timestamps.

## Threads and turns

The canonical session identifier is the Codex thread identifier. ATController supports:

- list, search, create, open, read, and resume
- rename and fork
- archive and restore
- explicit deletion with confirmation
- replacement threads for **Start Fresh**
- recovery after a runtime restart or an invalid stored selection
- structured history hydration after application restart

Turns use `turn/start`, `turn/steer`, and `turn/interrupt`. ATController preserves protocol ordering, tolerates unknown events, deduplicates repeated notifications, batches high-frequency updates, and keeps the current action visible without forcing the scroll position. Agent messages render safe GitHub-flavored Markdown, including headings, emphasis, lists, task lists, tables, block quotes, links, inline code, and copyable fenced code blocks. Raw HTML is not interpreted and remote Markdown images are not loaded.

Long histories are still read from Codex, but ATController renders the newest 24 turns first and reveals earlier turns in preserved-scroll pages. Verbose historical command and tool payloads are bounded with explicit truncation metadata before crossing the Tauri boundary; the canonical unabridged history remains owned by Codex.

## Resume commands and Terminal handoff

Thread menus expose:

- **Copy Resume Command**
- **Copy Full Access Resume Command**
- **Open Resume Command in Terminal**

ATController probes `codex resume --help` from the installed binary before constructing a command. The command contains the resolved Codex binary, canonical thread identifier, `--cd` workspace, and shell-safe quoting. Model, reasoning effort, and service tier overrides are included only when the user explicitly selected them. The Full Access form includes the installed CLI’s verified Full Access switch.

The default resume-command handoff opens Terminal.app in the thread workspace and inserts the exact command into zsh for review with `print -z`. Settings can opt into immediate execution. Insert-for-review reports a clear compatibility error when the login shell is not zsh.

## Project Terminal

Command J opens or hides the built-in Project Terminal shelf. Project and command context actions can open the same shelf at a validated directory inside the selected project. The shelf supports ANSI applications, interactive input, resize, clear, restart, stop, and a persisted panel height.

Rust owns each native PTY process. ATController starts the user’s configured absolute login shell directly, bounds its input and output queues, and allows at most one shell session per project. The working directory is canonicalized and must stay inside a registered project. Hiding the shelf keeps its session alive; stopping it or quitting ATController terminates the process group. Project Terminal output is neither parsed as Codex activity nor persisted as conversation history.

## Browser automation

ATController can expose browser automation to Codex through the official app-server MCP boundary. The initial production backend is `@playwright/mcp@0.0.77`, running a visible browser with an isolated profile. ATController never attaches to the user’s ordinary Chrome profile by default and never infers browser activity from assistant prose or terminal output.

Open **Browser → Browser Setup** from a thread or the command palette. Setup detects the installed Node.js, `npx`, browser, Codex MCP configuration, and Playwright tool inventory before changing anything. It shows the exact command and effects, then waits for an explicit **Configure Playwright MCP** action. ATController registers one managed Codex MCP entry named `atcontroller-playwright` through the installed CLI’s supported `codex mcp add` command. It does not silently install a global package or overwrite a foreign MCP entry with the same name.

The managed command pins the package version and uses settings equivalent to:

```text
<resolved-npx> -y @playwright/mcp@0.0.77
  --isolated
  --browser chrome
  --output-dir "~/Library/Application Support/ATController/browser-cache/playwright"
  --output-max-size 268435456
  --image-responses omit
  --console-level warning
  --timeout-action 10000
  --timeout-navigation 60000
  --codegen none
```

The setup screen renders the real argument-safe `codex mcp add` command for the current machine. After registration, ATController reloads MCP configuration through app-server and verifies that Codex can see the `browser_*` tools.

Each Codex thread has separate ATController browser metadata and app-server MCP routing. The Browser menu and inspector can open or stop the headed browser, take a screenshot, refresh page state, inspect console errors and failed requests, restart the session, hand control to the user, and return control to Codex. During a Codex turn, typed `mcpToolCall` items from `atcontroller-playwright` become compact navigation, interaction, console, network, screenshot, and failure cards in the normal timeline. Raw, redacted tool details remain behind progressive disclosure.

When structured command output reports a `localhost`, loopback, or `0.0.0.0` development-server URL, its command card offers **Open in Browser**. ATController rewrites `0.0.0.0` to the reachable loopback address and never auto-opens detected URLs.

Screenshots are lazy-loaded from the managed cache, associated with their thread, turn, session, URL, and activity, and bounded to 256 MB or 160 files. ATController persists browser UI metadata only. It does not persist cookies, passwords, authorization headers, form contents, or authentication tokens.

**Run Browser Self Test** creates a temporary local page, launches a real isolated headed browser, reads its title, interacts with it, takes a screenshot, closes the browser, and reports a structured result. Closing ATController first closes known browser sessions through Playwright MCP, then shuts down the owning app-server process group.

## Permissions

ATController exposes three thread-scoped modes and maps them to generated, structured app-server fields:

- **Standard** uses read-only sandboxing and on-request approvals.
- **Workspace Access** uses workspace-write sandboxing and on-request approvals.
- **Full Access** uses the danger-full-access sandbox and the `never` approval policy.

Full Access is the default for new threads in this product. A persistent indicator warns that Codex may read, modify, delete, and execute resources available to the current macOS user. ATController does not add redundant local confirmation dialogs to a Full Access turn.

ATController is not an operating-system sandbox. Choose Standard or Workspace Access for projects or instructions that are not fully trusted.

## Models, reasoning, and usage

Model, reasoning-effort, service-tier, permission-profile, account, plan, and rate-limit data come from the connected Codex runtime. ATController does not invent model names or reasoning values.

Requested and effective settings remain distinct. Runtime defaults and fallbacks are shown instead of silently presenting a rejected value as applied. Ultra appears only when the selected runtime model reports it.

Changing reasoning effort or access reinstantiates the same canonical Codex thread. If a turn is active, ATController interrupts it first, resumes the thread with the new structured settings, and leaves the last prompt stopped rather than silently replaying commands or edits.

## Attachments and skills

The composer serializes the exact structured input forms accepted by the generated protocol:

- text input
- local images
- bounded inline PNG, JPEG, GIF, and WebP data
- local file paths
- runtime-reported plugins and project skills

Type `@` in the composer to search with the keyboard. ATController uses app-server
`plugin/list` for the same plugin-level entries shown by Codex CLI, such as Browser,
Chrome, and Computer Use. Project skills discovered through `skills/list` under
`.github/skills` or `.agents/skills` remain individually selectable. Plugins use
their canonical `plugin://` mention identity; project skills use structured skill
inputs.

Inline images are limited to 10 MB. Files outside the active project are visibly marked, and the file picker requires confirmation before sharing them. Large ordinary files are passed by path instead of being converted into prompt text.

## Git and changes

Git remains the source of truth for the working tree. The inspector provides:

- current branch and clean/dirty state
- added, modified, deleted, renamed, copied, and conflicted files
- insertion and deletion counts
- per-file structured diffs
- open, reveal, copy path, copy patch, and confirmed revert
- copy the full working-tree patch
- safe branch switching and branch creation

App-server file events update the timeline immediately; Git refreshes reconcile the final filesystem state.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open folder | Command O |
| Import existing Codex projects | Command Shift O |
| New thread in selected project | Command N |
| Command palette | Command K or Command P |
| Focus composer | Command L |
| Stop active turn | Command . |
| Rename thread | Command Shift R |
| Search projects and threads | Command Shift F |
| Copy resume command | Command Shift C |
| Toggle sidebar | Command Shift S |
| Toggle inspector | Command Shift I |
| Toggle Project Terminal | Command J |
| Send | Return |
| New line | Shift Return |
| Optional alternate send | Command Return |

The command palette also exposes project, thread, resume, model, reasoning, permission, runtime, inspector, terminal, diagnostics, fork, and archive actions.

## Diagnostics

The diagnostics screen shows:

- ATController and Codex versions
- resolved binary and Codex home
- app-server/schema support and transport
- connection/initialization state, PID, uptime, and restart attempts
- authentication and plan state
- current model, reasoning, permission, approval, and sandbox settings
- active workspace, thread, and turn
- pending request and event-queue counts
- recent redacted stderr, protocol errors, and exit status
- Playwright MCP configuration, package/tool inventory, browser dependencies, cache path, session state, URL, page title, control owner, console errors, and failed requests

Actions can copy redacted diagnostics, run a connection self-test, restart the runtime, generate a protocol snapshot in the application data directory, open Codex configuration, or open ATController data.

Diagnostics redact credential-bearing values and do not include prompt content.

## Local data and migration

All ATController-owned data remains under:

```text
~/Library/Application Support/ATController/
```

The active layout is:

```text
settings.json
workspaces.json
codex-thread-ui.json
browser-sessions.json
migrations/app-server-v3.json
migrations/codex-settings-v1.json
migrations/project-shelves-v1.json
migration-backups/app-server-v3/
migration-backups/codex-settings-v1/
migration-backups/project-shelves-v1/
generated-codex-protocol/
browser-cache/playwright/
```

Codex owns conversation history in its own home directory. ATController does not duplicate full transcripts.

The app-server migration:

1. preserves registered local projects;
2. backs up settings, workspace definitions, and old thread metadata before rewriting;
3. maps only records with a canonical Codex session identifier;
4. preserves useful UI metadata;
5. records incompatible legacy runtime metadata in a report;
6. leaves original thread directories intact;
7. never passes incompatible identifiers to Codex.

The Codex-settings migration backs up and rewrites older settings through the current Codex-only schema so retired runtime and terminal-conversation fields cannot remain active.

The project-shelf migration separately backs up the previous workspace and thread UI files, canonicalizes valid local paths, preserves missing and malformed records in its report, associates thread UI metadata with explicit project IDs, and enriches projects with stable ordering and expansion metadata. It never rewrites Codex-owned transcripts.

Production builds always use the fixed Application Support path. Debug and test builds may use `ATCONTROLLER_APP_SUPPORT_ROOT` for isolated fixtures.

## Security

- The frontend can invoke only a narrow typed Tauri command surface.
- Workspace and project-file paths are canonicalized and checked against registered projects.
- There is no generic one-shot shell-execution command. Interactive input is accepted only by an explicitly opened Project Terminal PTY scoped to a registered project.
- Codex is spawned directly with an argument array.
- Protocol stdout, diagnostic stderr, and stdin remain separate.
- Protocol logs are bounded and redacted.
- Codex authentication tokens are never copied into ATController persistence.
- Browser automation uses an isolated profile and does not connect to the user’s normal Chrome profile.
- Browser tool inputs and results redact credentials, cookies, authorization values, sensitive query parameters, and form values before entering UI state or diagnostics.
- Screenshot paths must resolve beneath ATController’s managed browser cache before the frontend can read, reveal, or delete them.
- External URLs are limited to validated HTTP(S) values.
- The WebView uses a restrictive Content Security Policy.
- Shutdown terminates the app-server process group and escalates only after a timeout.

## Development

Install dependencies:

```bash
yarn install --ignore-engines
```

Generate bindings from the configured or discovered Codex binary:

```bash
yarn codex:generate-protocol
```

Verify that checked-in bindings match the installed Codex version:

```bash
yarn codex:check-protocol
```

Run the native application:

```bash
yarn tauri dev
```

Run the frontend alone:

```bash
yarn dev
```

## Testing

```bash
yarn test
yarn build
cargo test --manifest-path src-tauri/Cargo.toml
yarn test:contract
yarn test:browser-contract
yarn test:e2e
yarn verify
make verify
```

Unit tests cover protocol framing and normalization, browser event normalization and redaction, browser state and cache bounds, permission mapping, attachment serialization, native and WebKit file drops, state reduction, persistence migration, Git safety, Project Terminal path and size validation, safe Markdown rendering, structured timeline behavior, approvals, composer behavior, sidebar interactions, inspector actions, appearance, diagnostics, and keyboard command surfaces.

The real contract and end-to-end tests use a temporary Git repository, skip clearly when Codex is unavailable or unauthenticated, and never mutate a user project. The browser contract additionally starts two isolated Playwright sessions, proves that neither thread controls the other page, exercises a real Codex turn that emits structured browser MCP items, validates console/network/screenshot handling, and checks app-server/MCP process-group cleanup.

## Build and release

Build the local native application:

```bash
yarn tauri build --bundles app,dmg
```

Create the exact local release filenames:

```bash
yarn package:local
```

Artifacts are written to:

```text
src-tauri/target/release-assets/ATController.dmg
src-tauri/target/release-assets/ATController.app.zip
```

Version fields stay synchronized across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. See [docs/releasing.md](docs/releasing.md) for signing, notarization, and GitHub Release details.

## Compatibility and troubleshooting

If startup fails:

1. Run `which codex`, `codex --version`, and `codex app-server --help`.
2. Confirm Codex authentication with `codex login status`.
3. Open **Runtime → Diagnostics** and run the connection self-test.
4. Configure an explicit Codex binary path if login-shell discovery selects the wrong installation.
5. Regenerate protocol bindings after upgrading the local Codex CLI.
6. Restart the runtime and reopen the thread.

Unknown notifications are retained as generic structured activity instead of crashing the session. Unsupported required capabilities produce explicit upgrade or compatibility errors; ATController does not fall back to terminal scraping.

The browser is intentionally a separate headed window in this release. ATController provides status, screenshots, activity, and lifecycle controls in its inspector; it does not embed Chrome, animate a synthetic cursor, forward mouse input, or connect to a personal browser profile. MCP and browser child PIDs are shown only when the installed app-server exposes a safe identity—ATController does not guess by globally matching Chrome or Node processes.

See [docs/known-issues.md](docs/known-issues.md) for current runtime-specific limitations.
