# Handoff: move to a Debian server

Written 2026-10-10 on branch `ai/server-workspace` for the next agent working on this project. AGENTS.md remains the source of rules; this file explains what changed and what is still open. Like everything committed here, it must not name the user's hostnames, domains, paths or other personal details; ask the user when you need them.

## Where things stand

The project used to run only on the user's Mac. `/canvas-update` synced Canvas on demand, credentials sat in the macOS Keychain, and the vault lived in a cloud-drive folder so the user could read it on their phone. The user wants Canvas fetched without reaching for the laptop, so the project is moving to an always-on Debian server that agents reach over SSH. Development may happen in other environments that are not production. Other people should be able to use the project too, so everything personal lives in gitignored configuration.

Decisions the user made:

- **Only the deterministic fetch runs on a schedule.** A systemd user timer runs `bun run fetch`. No AI runs in the background, and nothing touches Notion or Google Calendar unattended.
- **The report runs on demand.** `/canvas-report` replaces `/canvas-update`. It shows every change since the user last reviewed a report, then runs the original canvas-to-Notion workflow unchanged, with the same standing permissions: matched task page bodies may be rewritten, while date writes, new tasks and calendar writes still need per-report approval. Every report request starts with a locked, fresh, read-only fetch; scheduled fetches keep the vault current between reports.
- **The vault is served from the server.** There is no paid Obsidian Sync and no cloud drive. `rclone serve webdav` listens on localhost, a Cloudflare tunnel can publish it, and the Remotely Save community plugin syncs the user's devices on startup and on a schedule. Each device's vault is named `Canvas`.
  - The user wants the address public rather than behind a VPN, so with the tunnel on, WebDAV basic auth over HTTPS is the only protection.
  - Remotely Save's own encryption is unusable because the server writes plain files.
- **Server parts are toggles.** `server.fetchSchedule`, `server.webdavPort` and `server.tunnel` in `config.json` turn each part on or off.
- **Nothing personal is committed.** `config.json` is gitignored and `config.example.json` is the template. Secrets live in `~/.config/nus-canvas-sync/`. Docs use placeholders.
- **Branches use `ai/`, not `claude/`.**

## What changed in the code

- The `sync` command is now `fetch` (`bun run fetch`; `fetchCanvas` in `src/sync.ts`). User-facing report wording says "fetch". The raw field `unseen-changes.json#last_sync` keeps its name deliberately, so the raw format does not change.
- `bun run changes --reviewed --through <last_sync>` refuses when a fetch ran after the report was shown, so a scheduled fetch cannot cause unseen changes to be marked reviewed. The skill always passes `--through`; acknowledgement requires that exact report endpoint. Retained timestamped history and the separate review cursor are implemented on `ai/report-history`.
- `config.json` is untracked. `loadConfig` tells you to copy `config.example.json` when it is missing, and `deploy/setup.sh` does that copy itself. `vaultDirectory` defaults to `./vault` (gitignored), so every checkout has its own vault next to its own `raw/`.
- `src/vault.ts` already used `COPYFILE_FICLONE`, which falls back to a plain copy on filesystems without clones; only the comment and README changed.
- The skill moved to `.claude/skills/canvas-report/SKILL.md`. Report links use `obsidian://open?vault=Canvas&file=...`, because absolute server paths do not open on a phone.
- `deploy/` is new:
  - `setup.sh` and `teardown.sh`
  - systemd user unit templates, where `@REPO@`, `@VAULT@`, `@SCHEDULE@` and `@PORT@` are filled in by the script
  - `README.md` with the setup steps
- README and AGENTS.md are updated for the server: no Homebrew, Keychain or cloud drive.

## The setup script

`deploy/setup.sh` works on any development checkout. It does not need sudo. It installs bun and canvas-cli into `~/.bun` and `~/.local/bin`, runs `bun install`, and creates `config.json` from the example.

`deploy/setup.sh --production` reads the `server` toggles, then:

- installs rclone and cloudflared only if they are needed;
- prompts once for the WebDAV credentials and the tunnel token, stored mode 600;
- writes and enables the units that are on, and disables and removes the ones that are off.

It is safe to rerun and keeps existing secrets.

`deploy/teardown.sh` undoes it: it stops and removes the units. `--secrets` also deletes the stored secrets and logs canvas-cli out, and `--tools` also deletes rclone and cloudflared. It never deletes `raw/`, the vault or `config.json`.

Never run `--production`, `systemctl --user` or a manual fetch in a development environment. Production is the checkout where `systemctl --user is-active canvas-fetch.timer` prints `active`. On production, a manual fetch is `flock raw/.fetch.lock bun run fetch`.

## Verified, and not yet

Verified on the Mac:

- `bun run verify` passes.
- `setup.sh --production` ran end to end with stubbed `systemctl`, `loginctl` and `flock`, both with every part on and with WebDAV and the tunnel off on a 30-minute schedule. Secrets were mode 600, units rendered with the right values, and turned-off units were disabled and removed.
- `rclone serve webdav` returned 401 without the credentials from `RCLONE_USER`/`RCLONE_PASS`, 200 with them, and 207 for `PROPFIND` with `Depth: infinity`.
- All download URLs returned 200.

Not verified, because nothing has run on Debian yet:

- the real systemd units and linger;
- canvas-cli's encrypted-file token store (used where there is no Secret Service) when run from a systemd user service;
- the Cloudflare tunnel;
- Remotely Save against rclone through Cloudflare on iOS and macOS.

Once the user has followed `deploy/README.md`:

1. Check the first `journalctl --user -u canvas-fetch` run.
2. Confirm `/canvas-report` works on the server with the Notion and Google Calendar connectors.

## Things to know

- `config.json`, `STYLE.md` and `known-content.json` are gitignored, so a fresh clone lacks them. The user copies them, with `raw/`, from the old machine (deploy/README.md step 2).
  - Without `STYLE.md` you cannot follow the style rules; ask for it.
  - Without `known-content.json`, fetches silently miss directly fetched content.
- Copying `raw/` keeps the user's unseen changes and avoids a new baseline. If it was not copied, the first server fetch reports "First fetch" for every course.
- The server's vault is the source for generated notes; Remotely Save uploads only the user's own notes. A fetch never deletes files it did not generate (`raw/<COURSE>/vault.json`). Remotely Save may add its own metadata files to the vault root; leave them alone.
- Older commits on `main`, already pushed, still contain the user's previous personal vault path in `config.json`. Removing it would mean rewriting `main`'s history, which needs the user's explicit approval.
- The user finds sudo prompts annoying. Keep the project sudo-free; the optional sudoers drop-in in deploy/README.md is their decision.
- Ask before pushing.
