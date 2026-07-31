# Known Issues

## Codex protocol compatibility

ATController generates its protocol bindings from the installed Codex CLI. Upgrading Codex can add notifications or fields before ATController has a specialized renderer for them.

Unknown notifications are preserved as generic structured activity. Missing required stable methods produce a compatibility error instead of falling back to terminal parsing.

After upgrading Codex, run:

```bash
yarn codex:generate-protocol
yarn codex:check-protocol
```

Review and commit the generated changes with any required normalization updates.

## Thread deletion in Codex CLI 0.144.0

Some installations of Codex CLI 0.144.0 remove a temporary thread rollout and then report a database cleanup error involving missing agent-job state. ATController confirms whether the thread is gone before deciding whether deletion failed.

This is an installed-runtime behavior. It does not affect listing, resume, archive, or restore.

## Account-dependent usage data

ATController displays only rate-limit windows supplied by the signed-in Codex account. Some authentication modes or plans do not return both the five-hour and weekly windows.

An unavailable value means the runtime did not report that window. ATController does not estimate usage.

## Insert-for-review requires zsh

The safe default for **Open Resume Command in Terminal** inserts the shell-escaped command for review with zsh `print -z`.

When the configured login shell is not zsh, ATController reports an explicit compatibility error. Choose **Execute immediately** in Settings only if that behavior is intended.

## Unsigned local builds

Local and branch builds use an ad-hoc or development signature. Gatekeeper may
require an explicit first-open action.

macOS protects Desktop, Documents, and Downloads independently. ATController
asks for those files only when a project or explicitly attached file requires
them. A signed build normally retains the user's choice. An ad-hoc signature's
code requirement changes when the executable is rebuilt, so macOS may ask again
after each local native build. Use a persistent identity with
`ATCONTROLLER_LOCAL_SIGNING_IDENTITY` and `yarn build:app:local` when permission
persistence is important. ATController does not request Full Disk Access or
bypass macOS privacy controls.

Tagged production releases require Developer ID signing, notarization, and
stapling before publication.

## Runtime-generated model availability

Models, reasoning efforts, Ultra, and service tiers can change with the installed runtime and account. A previously selected value may become unavailable after a Codex update or account change.

ATController keeps the requested value distinct from the effective runtime value and reports fallback or rejection instead of silently downgrading.

## Full Access

Full Access configures `danger-full-access` with the `never` approval policy. Codex can read, modify, delete, and execute resources available to the current macOS user.

Use Standard or Workspace Access when that scope is not appropriate. ATController is not an operating-system sandbox.
