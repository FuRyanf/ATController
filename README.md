# ATController

ATController is a native macOS desktop application for running the local OpenAI Codex CLI across multiple workspaces and threads.

Codex is ATController’s only runtime. ATController launches the local `codex` executable in a real pseudo-terminal, renders the interactive terminal in the app, and keeps workspace, thread, and run state on your Mac. It does not proxy Codex through an ATController service or call the OpenAI API itself.

## Highlights

- Local, SSH, and rdev workspaces in one desktop interface
- Recent, unarchived local Codex history directly in each workspace sidebar
- Persistent, resumable local Codex threads with saved terminal output
- Manual and bulk import of existing local Codex sessions
- Model, reasoning-effort, Standard/Fast, 5-hour usage, and weekly usage controls
- Workspace and full-access permission modes for each thread
- Repository and personal Codex skill discovery
- File and image attachments for the next prompt
- Git status, branch switching, and optional pull-before-start behavior
- Unread indicators, macOS notifications, and Dock badge counts
- System, light, and dark appearances

## Requirements

- Apple silicon Mac with macOS 12 or newer
- OpenAI Codex CLI installed and authenticated

Install the Codex CLI:

```bash
npm install --global @openai/codex
codex login
codex login status
```

Codex supports ChatGPT sign-in and API-key authentication. See the [official Codex authentication documentation](https://developers.openai.com/codex/auth) for current options.

For remote SSH or rdev workspaces, install and authenticate the Codex CLI in the remote environment as well.

## Install ATController

Download the current release:

- [ATController.dmg](https://github.com/FuRyanf/ATController/releases/latest/download/ATController.dmg)
- [ATController.app.zip](https://github.com/FuRyanf/ATController/releases/latest/download/ATController.app.zip)

Open `ATController.dmg`, then drag `ATController.app` to Applications.

Production releases are Developer ID signed, notarized by Apple, and stapled before publication. Pull-request, branch, and manually dispatched CI builds are always unsigned development artifacts and are never published as releases.

## Core Concepts

### Workspaces

A workspace is the working directory for Codex and related shell operations.

- Local workspaces run Codex on this Mac.
- SSH and rdev workspaces open the configured remote shell, then start Codex there.

ATController stores connection commands and workspace settings locally. Credentials remain managed by your shell, SSH configuration, and Codex.

Connection commands are parsed as argument lists and reconstructed safely before they reach the login shell. Shell composition (including separators, substitutions, redirects, and newlines), custom remote commands, SSH options that can load or execute command-supplied local helpers, and modes that prevent an interactive Codex session are rejected. Put trusted advanced SSH behavior in `~/.ssh/config`; `{CODEX_CMD}` is supported only as a single final argument for connection tools that require an explicit command placeholder.

Automatic Codex session-ID discovery and durable resume are local-workspace features. Remote Codex history remains on the remote machine, and ATController does not inspect remote rollout JSONL; SSH and rdev threads should be treated as terminal sessions without guaranteed automatic resume.

### Threads

A thread is a named Codex conversation within a workspace. Each thread can persist:

- its Codex session ID
- permission mode
- enabled skills
- activity and unread state
- run metadata and terminal output

Opening a local thread starts a new Codex session or resumes its saved session when ATController has discovered its session ID. Remote threads start Codex in the configured remote shell and do not guarantee automatic resume. Deleting a thread removes ATController’s local metadata and logs; it does not delete the source session from Codex’s own history.

For local workspaces, ATController reads the same active local Codex session history used by its
import screen and merges recent, unarchived sessions into the sidebar by activity time. A history row is imported atomically the
first time you open it, so the session becomes a normal resumable ATController thread without
duplicating ownership or leaving a half-created row after a failed import. Archived Codex sessions
are not shown.

### Model, Speed, and Usage

The bottom bar shows the effective local Codex model, Standard/Fast mode, and the usage windows
reported by the signed-in Codex CLI. Open it to select a catalog-supported model and reasoning
effort, toggle Fast mode when the selected model supports it, and inspect reset times.

These choices update the local Codex user configuration and apply when a local session next starts
or resumes. They do not override a remote SSH or rdev installation. Usage availability depends on
the Codex account: if Codex does not report a 5-hour or weekly window, ATController labels that
window unavailable instead of estimating it.

### Permission Modes

ATController exposes two explicit Codex execution modes:

- **Workspace** starts Codex with `--sandbox workspace-write --ask-for-approval on-request`.
- **Full access** starts Codex with `--dangerously-bypass-approvals-and-sandbox`.

Workspace mode is the default unless you explicitly change the new-thread default in Settings. Full access disables Codex’s approval and sandbox protections and should only be used for workspaces and instructions you trust.

### Session Import

ATController can import a Codex session by ID or scan the local Codex session history for bulk import into a local workspace.

The discovery root is:

- `$CODEX_HOME/sessions/` when `CODEX_HOME` is set
- `~/.codex/sessions/` otherwise

Import creates ATController thread metadata that resumes the selected Codex session. It does not copy or modify Codex’s source rollout files.

### Skills

ATController discovers Codex skills from repository and personal skill directories:

- `<workspace>/.agents/skills/`
- `~/.agents/skills/`

Selected skills are added to the next prompt locally.

## Local Data

ATController preserves all application-owned data under:

```text
~/Library/Application Support/ATController/
```

The main files and directories are:

```text
workspaces.json
settings.json
sidebar-hidden-codex-sessions.json
threads/<workspaceId>/<threadId>/thread.json
threads/<workspaceId>/<threadId>/runs/<runId>/input_manifest.json
threads/<workspaceId>/<threadId>/runs/<runId>/metadata.json
threads/<workspaceId>/<threadId>/runs/<runId>/output.log
```

Back up this directory to preserve ATController workspace metadata, thread state, and local run logs.

ATController bounds its own terminal history. Each active `output.log` is atomically compacted
from 8 MiB to its most recent 6 MiB, while logical stream positions remain monotonic so reconnect
snapshots can identify omitted output. ATController keeps the newest 32 run directories for each
thread and the newest 32 workspace-shell session directories for each workspace. The latest
recorded thread run and directories marked by a live ATController process are never pruned, even
when they are outside that newest-32 window. Codex’s own session history under `$CODEX_HOME` is not
modified by this retention policy.

On the first launch after upgrading, ATController performs a one-time in-place safety migration. Existing thread metadata is preserved, but any legacy thread that had Full access enabled is reset to Workspace mode so unrestricted execution must be explicitly re-enabled. Completion is recorded atomically at:

```text
~/Library/Application Support/ATController/migrations/codex-only-v1.json
```

The migration also disables any legacy setting that made new threads start with Full access. Malformed legacy JSON encountered during this migration is preserved beside its original location with a `.codex-only-v1.invalid` suffix and excluded from active state; malformed settings and workspace indexes are recreated with safe defaults. After the migration is complete, newly corrupted active files produce an error and are not silently overwritten.

A second one-time migration removes pre-Codex, unbound legacy thread rows from the live sidebar.
Their complete directories are moved—not deleted—to:

```text
~/Library/Application Support/ATController/migration-backups/codex-sidebar-v2/threads/
```

Completion is recorded in `migrations/codex-sidebar-v2.json`. Threads created after the Codex-only
migration and threads already bound to a Codex session are preserved.

When you explicitly delete an imported thread or remove its project, ATController records the
Codex session ID in `sidebar-hidden-codex-sessions.json`. This keeps the still-intact source Codex
history from immediately reappearing. Explicit manual or bulk import restores it.

## Privacy and Network Access

ATController has no analytics or telemetry of its own and does not upload its application data to an ATController service. Codex CLI authentication and network behavior remain governed by Codex and its configuration.

At startup and every 10 minutes while the application remains open, ATController requests the latest release metadata from the ATController repository on the GitHub Releases API. These checks do not download a release artifact. `ATController.dmg` is downloaded only after you explicitly click **Update**; ATController then verifies the update before replacing the installed application.

ATController-owned terminal output logs, input manifests, and run metadata are plaintext files in the application data directory. They can contain sensitive prompts, paths, commands, attachment references, and command output. ATController does not encrypt these files; protect them with the same macOS account and backup controls you use for other sensitive local development data.

## Security Model

ATController runs the Codex CLI as your macOS user through your login shell. It does not create a separate operating-system account or security boundary.

- Workspace mode keeps Codex’s workspace sandbox and on-request approvals enabled.
- Full access must be explicitly enabled for a thread or as the new-thread default, and it disables those protections.
- Codex authentication remains in Codex’s configured credential storage; ATController does not copy credentials into its data directory.
- ATController’s plaintext local logs and metadata follow the retention policy above; deleting a thread removes those ATController-owned files but not Codex’s source history.
- Remote sessions inherit the permissions and environment of the configured remote account.
- Skills, attachments, and repository instructions can influence agent behavior. Review untrusted content before using it.

For more on Codex sandbox and approval behavior, see the [official Codex approvals and security documentation](https://developers.openai.com/codex/agent-approvals-security).

## Development

### Prerequisites

- Node.js 20.19+ or 22.12+
- Yarn 1.22
- Rust 1.88 or newer
- Xcode Command Line Tools
- Codex CLI for live PTY verification

Install dependencies:

```bash
yarn install --frozen-lockfile
```

Run the macOS app in development:

```bash
yarn tauri dev
```

Run the frontend only:

```bash
yarn dev
```

Build the native Apple silicon application:

```bash
rustup target add aarch64-apple-darwin
yarn run tauri -- build --target aarch64-apple-darwin -- --locked
```

The application bundle is named `ATController.app`.

Create locally verifiable Apple silicon packages with the production artifact names:

```bash
yarn package:local
```

This writes `ATController.dmg` and `ATController.app.zip` to
`src-tauri/target/release-assets/`. Local packages use a resource-sealed ad-hoc
signature; tagged production releases remain Developer ID signed and notarized
by the protected GitHub Actions workflow.

## Verification

Run the frontend build and UI tests:

```bash
yarn build
yarn test:ui
```

Run Rust tests:

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Run the full verification sequence:

```bash
make verify
```

The full sequence runs the product/runtime audit, frontend build, UI tests, Rust tests, and Codex PTY smoke test. Logs are written to `artifacts/e2e/`, with the latest diagnosis in `artifacts/last_diagnosis.txt`.

Release CI additionally audits the locked Rust graph against RustSec for the
`aarch64-apple-darwin` target. Vulnerable, unsound, and yanked packages fail that check;
unmaintained-only notices remain visible without blocking releases.

See [`docs/manual-terminal-rendering.md`](docs/manual-terminal-rendering.md) for the live terminal checklist.

## Releases

ATController releases use stable numeric SemVer (`major.minor.patch`). Keep these version fields aligned:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

Set and verify a release version:

```bash
node scripts/sync-version.mjs set 0.1.0
node scripts/sync-version.mjs check 0.1.0
```

Push an annotated `v*` tag only after the version change is on `main`:

```bash
git tag -a v0.1.0 -m "ATController v0.1.0"
git push origin v0.1.0
```

The macOS GitHub Actions workflow builds a native Apple silicon application and publishes exactly:

- `ATController.dmg`
- `ATController.app.zip`

Tag builds attach those files to the GitHub Release only after production signing and notarization verification succeeds. A tag build fails closed if any required Apple secret is unavailable.

### Signing and Notarization

Create a protected GitHub Actions environment named `production` and configure these environment secrets for signed and notarized releases:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password for the certificate
- `APPLE_SIGNING_IDENTITY`: Developer ID Application certificate name
- `APPLE_ID`: Apple ID used for notarization
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple Developer Team ID, also used as the expected code-signing `TeamIdentifier`

Require approval for the `production` environment and restrict it to protected `v*` tags. Protect `main` and those tags from unauthorized creation or modification, and enable immutable releases in the repository settings. Apple credentials are exposed only to the fresh tag-only release job after its test dependencies pass and the remote tag is confirmed to still resolve to a commit contained in `main`.

Pull-request, `main`, and manually dispatched builds produce only clearly named unsigned development artifacts and never receive Apple credentials. Version-tag builds require every secret above and never publish unsigned or unnotarized artifacts.

The release workflow verifies the exact bundle name, identifier, and version; the thin `arm64` executable; Developer ID signature and Team ID; Gatekeeper assessment; notarization tickets; DMG integrity; release/tag freshness; and the exact two artifact names before publishing without overwriting assets.

See [`docs/releasing.md`](docs/releasing.md) for the complete release checklist.

## Architecture

ATController has three local layers:

- React and TypeScript implement the workspace, thread, settings, and terminal interface.
- Tauri and Rust manage persistence, git operations, session discovery, and PTY lifecycle.
- `portable_pty` launches the local shell and Codex CLI, while xterm.js renders the byte stream.

For runtime flow and persistence details, see [`technology.md`](technology.md).

## Troubleshooting

### Codex CLI is not detected

1. Confirm `codex --version` works in Terminal.
2. Open ATController Settings and set the Codex CLI path explicitly if needed.
3. Reopen the thread after changing the path.

ATController launches through your login shell (`$SHELL -lic`, with `/bin/zsh` as the fallback), so shell startup errors can also affect detection.

### Codex is not authenticated

Run:

```bash
codex login
codex login status
```

For a remote workspace, run those commands on the remote machine.

### A saved session will not resume

Confirm that the session still exists under the active Codex home and belongs to the selected workspace. Use **Start fresh** to clear the saved session ID and begin a new Codex session without deleting the old rollout file.

### MCP or shell tools differ from Terminal

Compare ATController’s environment diagnostics with your normal Terminal session. Check login-shell startup files such as `~/.zprofile` and `~/.zshrc`, and confirm that any required MCP servers are configured for the same Codex home.

### Remote workspace will not start

Test the configured SSH or rdev command directly in Terminal, then confirm that `codex --version` and `codex login status` work after connecting.

## Icons

The canonical icon source is `app icon.jpg`. Generate all platform icon assets with:

```bash
yarn generate:icons
```

Generated assets are written to `assets/icon.png` and `src-tauri/icons/`.
