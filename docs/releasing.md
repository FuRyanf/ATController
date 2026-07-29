# Releasing ATController

ATController version tags publish a production macOS release only after signing and notarization verification succeeds. Pull-request, `main`, and manually dispatched builds are development artifacts and are never promoted automatically.

## Protected Release Environment

Create a GitHub Actions environment named `production`. Require reviewers for that environment, restrict deployment branches and tags to protected `v*` tags, and configure these environment secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application certificate in `.p12` format
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12`
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity name
- `APPLE_ID`: Apple ID used for notarization
- `APPLE_PASSWORD`: app-specific password for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer Team ID

`APPLE_TEAM_ID` is used both for notarization and as the expected `TeamIdentifier` extracted from the signed application. A version-tag job stops immediately if any required secret is empty.

Protect `main` and the repository’s `v*` tags from unauthorized creation or modification. Enable immutable releases in the repository’s **Settings → General → Releases** section. These controls are required production setup: the workflow intentionally cannot create Apple credentials, environment approvals, or repository rules.

The release job receives the environment secrets only after the Rust advisory and full macOS test jobs succeed, the environment is approved, and the tagged commit is confirmed to be contained in `main`. Pull-request, branch, and manually dispatched jobs never receive Apple credentials and create only unsigned artifacts whose filenames contain `development`.

See Tauri’s [macOS code-signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/) when creating or rotating these credentials.

## Prepare a Version

Production tags use stable numeric SemVer (`major.minor.patch`); prerelease and
build-metadata suffixes are intentionally rejected so macOS bundle versions,
update comparisons, and GitHub tags stay identical.

Keep the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` aligned:

```bash
node scripts/sync-version.mjs set 0.1.0
node scripts/sync-version.mjs check 0.1.0
```

Run the local checks:

```bash
yarn audit:branding
yarn audit --level moderate
yarn build
yarn test:ui
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo deny --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin check -A unmaintained advisories
```

Commit the aligned version to `main` before creating the tag.

## Publish

Create an annotated tag whose value exactly matches the repository version:

```bash
git tag -a v0.1.0 -m "ATController v0.1.0"
git push origin v0.1.0
```

The macOS workflow then:

1. confirms the remote tag still resolves to the workflow commit and that the commit is contained in `main`.
2. audits the product identity, runtime scope, and dependencies.
3. runs frontend and Rust checks in a job that has no Apple credentials.
4. waits for approval of the protected `production` environment.
5. requires all signing and notarization secrets in a fresh tag-only job.
6. builds the native Apple silicon `ATController.app`.
7. verifies bundle name, `com.furyanf.atcontroller`, and tag-aligned version.
8. verifies the executable is a thin `arm64` binary.
9. verifies the Developer ID signature and expected Apple Team ID.
10. runs Gatekeeper and notarization-ticket validation against the application and DMG.
11. verifies the DMG and ZIP contents use the exact application name.
12. rejects an existing release, a moved tag, or a version that is not newer than the latest release.
13. publishes exactly `ATController.dmg` and `ATController.app.zip` without overwriting assets.

The GitHub Release job cannot run unless the macOS verification job succeeds.

## Post-release Check

Download both assets from the GitHub Release and confirm:

- the uploaded binary assets are exactly `ATController.dmg` and `ATController.app.zip`
- the DMG opens and contains `ATController.app`
- `ATController.app` launches normally on an Apple silicon Mac that did not build it
- About ATController reports the tagged version
- a Workspace-mode thread starts with workspace-write sandboxing and on-request approvals
- Full access requires an explicit thread or new-thread-default choice
