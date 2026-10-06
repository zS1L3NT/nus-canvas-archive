# Agent instructions

This repository syncs NUS Canvas, read-only, into an Obsidian vault at `~/NUS/Canvas` and reports every change since the user last reviewed one.

When the user asks for a Canvas update, what changed on Canvas, or a Canvas to Notion update, follow the [canvas-update skill](.claude/skills/canvas-update/SKILL.md) (also `/canvas-update`). Everything below is for working on the project itself; an update never changes the code, and code work never touches Notion.

Follow [STYLE.md](STYLE.md) strictly for every code change, and put future code-style rules there rather than here.

## Rules

- Commit finished, verified work yourself on a `claude/` branch, using the repo's emoji-prefixed message style. Ask before pushing, amending, or rewriting history.
- Never expose, copy, log, or persist Canvas credentials. `canvas-cli` holds them in the macOS Keychain.
- Never create, update, submit, grade, publish, or delete anything in Canvas.
- Preserve stable identifiers, source URLs, timestamps, hashes, and warning details; diffs and indexing depend on them.
- Preserve and display external links found in Canvas content, even when the linked content cannot be downloaded.
- Read warning messages themselves, not counts, and interpret them in context. A warning is a coverage note, not proof of missing content.
- Do not add grades, submissions, quiz attempts, rosters, or other sensitive student data without explicit user direction.
- Do not restore the retired browser/AppleScript scraper, the numbered Finder view, or run logs.

## Layout

| Path | Role |
|---|---|
| `src/sync.ts` | Canvas collection, raw archive, commands |
| `src/vault.ts` | Obsidian vault: naming, notes, link rewriting, course notes, `Home.md` |
| `src/changes.ts` | Unseen-change tracking, readable diffs, warning classification, report |
| `src/tasks.ts` | Normalized assignment and quiz list shared by the vault and `bun run tasks` |
| `src/lib/` | Normalization, hashing, text extraction, naming, dates |
| `config.json` | Courses, directories, timezone, limits |
| `known-content.json` | Canvas IDs to fetch directly when list endpoints are unavailable |
| `raw/` | Generated machine data: API responses, `documents.jsonl`, manifests, `state.json`, `unseen-changes.json` |
| `~/NUS/Canvas` | Generated vault; must stay free of implementation details |

`canvas` comes from Homebrew (`brew install jjuanrivvera/canvas-cli/canvas-cli`), not from this repository.

## Working on the code

- Keep every Canvas operation read-only. Prefer structured JSON and deterministic, atomic outputs.
- Keep `raw/` optimized for diffing and indexing: stable ordering and IDs, normalized text, explicit metadata, content hashes. A change to how raw documents are rendered shows up as a modification of every affected document, so avoid incidental format changes.
- Keep the vault clean for a person: no numbering, IDs, logs, or machine files; dates in Singapore time; Canvas links rewritten to local notes and files where they exist; external links preserved.
- The vault only removes files it generated (tracked in `raw/<COURSE>/vault.json`); never delete anything else there, such as `.obsidian/` or the user's own notes.
- Never hand-edit `raw/` or the vault. Change the generator and run `bun run vault` (offline) or `bun run sync`.
- Do not report removals for a resource kind whose collection was incomplete or warned.
- Preserve valid downloads when Canvas temporarily withholds a download URL, and never save an HTML error page as an attachment. A file with no download URL is usually unreleased: keep its metadata and retry it every sync.
- A missing Pages or Quizzes list often means the course does not use the feature. Classify it as a coverage note, not missing content.
- Delete raw content only with explicit user authorization for the exact targets.

## Verification

```sh
bun run verify
bun run doctor
```

Run `bun run vault` to check vault output against the existing archive without contacting Canvas. Run `bun run sync` only when a live, read-only refresh is needed; note that it adds to the user's unseen changes. Review the report's warnings and the vault output before declaring success.
