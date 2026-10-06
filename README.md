# NUS Canvas vault

Syncs NUS Canvas, read-only, into an Obsidian vault at `~/NUS/Canvas`, and keeps a list of every Canvas change you have not reviewed yet.

## Daily use

Open this folder in Claude Code (the Code tab of the desktop app, or `claude` in a terminal; claude.ai chat cannot reach your Mac's files or Keychain) and ask for a **Canvas update**, or run `/canvas-update`. Claude will:

1. run `bun run sync`;
2. show you every change since your last update: new and edited announcements, assignments, quizzes, pages, files and messages, with date changes and line diffs;
3. reconcile your Notion Task Tracker and the NUS Exams calendar;
4. mark the changes as reviewed.

Nothing runs in the background. Changes accumulate until you review them, so if you sync from a terminal in between, nothing is lost.

## The vault

Open `~/NUS/Canvas` as a vault in Obsidian and start from `Home.md`, which lists courses and everything due next.

```
~/NUS/Canvas/
  Home.md
  CS2030S/
    CS2030S.md        deadlines, modules in Canvas order, syllabus
    Assignments/      one note per assignment (due, opens, closes, points in properties)
    Quizzes/
    Announcements/    2026-10-02 PE1 Reminder.md
    Inbox/
    Pages/
    Files/            Canvas folder tree
    Attachments/      images and hidden files embedded in notes
```

Canvas links inside notes point at the local note or file when it exists, so the vault works offline. Times are in Singapore time. Vault files are APFS clones of `raw/`, so the vault takes almost no extra disk space.

The sync only replaces or removes files it generated. Your own notes and `.obsidian/` settings in the vault are left alone; avoid editing generated notes, because the next sync overwrites them.

## Commands

```sh
bun run sync                    # read Canvas, update raw/ and the vault, print unseen changes
bun run sync --course CS2030S   # one course
bun run sync --metadata-only    # skip file downloads
bun run changes                 # reprint unseen changes without contacting Canvas
bun run changes --reviewed      # mark them reviewed
bun run tasks                   # JSON of every assignment and quiz with Singapore-time dates
bun run vault                   # rebuild the vault from raw/ without contacting Canvas
bun run doctor
bun run verify
```

## Setup

```sh
brew trust jjuanrivvera/canvas-cli
brew install jjuanrivvera/canvas-cli/canvas-cli
bun install --frozen-lockfile
bun run doctor
```

`canvas-cli` keeps the Canvas token in the macOS Keychain; nothing secret is stored here. Courses, directories and the timezone live in `config.json`.

## Raw archive

`raw/` is machine data for diffing and AI indexing: lossless API responses, `documents.jsonl` (normalized records), `file-manifest.json`, extracted text under `content/text/`, `state.json`, and `unseen-changes.json`. Grades, submissions, quiz attempts and rosters are deliberately not collected. Inbox collection is limited to each course's conversations and never marks them read.
