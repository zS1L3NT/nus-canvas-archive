# NUS Canvas Sync

`nus-canvas-sync` fetches NUS Canvas, read-only, into the Obsidian vault in the vault directory (`vaultDirectory` in `config.json`), and keeps a list of every Canvas change you have not reviewed yet.

It is meant to run on an always-on Debian server: a systemd timer fetches Canvas on a schedule, and the vault can be served over WebDAV, optionally through a Cloudflare tunnel, for the Remotely Save plugin in Obsidian. Each part is toggled under `server` in `config.json`; setting up the server is described in [deploy/README.md](deploy/README.md).

## Daily use

Open this folder on the server in Claude Code and ask for a **Canvas report**, or run `/canvas-report`. Claude will:

1. show you every change since your last report: new and edited announcements, assignments, quizzes, pages, files and messages, with date changes and line diffs;
2. reconcile your Notion Task Tracker and the NUS Exams calendar;
3. mark the changes as reviewed.

The report uses the latest scheduled fetch; ask for a fresh fetch if you need one. Changes accumulate until you review them, so nothing fetched between reports is lost.

## The vault

Open the vault named Canvas in Obsidian and start from `Home.md`, which lists courses and everything due next.

```
<vault directory>/
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

Canvas links inside notes point at the local note or file when it exists, so the vault works offline. Times are in Singapore time. On filesystems with clones (APFS, Btrfs, XFS), vault files share blocks with `raw/`.

A fetch only replaces or removes files it generated. Your own notes and `.obsidian/` settings in the vault are left alone; avoid editing generated notes, because the next fetch overwrites them.

## Commands

```sh
bun run fetch                   # read Canvas, update raw/ and the vault, print unseen changes
bun run fetch --course CS2030S  # one course
bun run fetch --metadata-only   # skip file downloads
bun run changes                 # reprint unseen changes without contacting Canvas
bun run changes --reviewed      # mark them reviewed
bun run tasks                   # JSON of every assignment and quiz with Singapore-time dates
bun run vault                   # rebuild the vault from raw/ without contacting Canvas
bun run doctor
bun run verify
```

On the server, run a manual fetch as `flock raw/.fetch.lock bun run fetch` so it waits for the scheduled one.

## Setup

```sh
sudo apt install curl unzip git util-linux   # once
deploy/setup.sh                              # bun, canvas-cli, dependencies and config.json, no sudo
canvas auth token set nus --url https://canvas.nus.edu.sg
bun run doctor
```

`canvas-cli` keeps the Canvas token in the system keyring, or its own encrypted file where there is none; nothing secret is stored here. Courses, directories, the timezone and the server toggles live in `config.json`, which is gitignored because it holds personal details; `config.example.json` is the template.

## Raw archive

`raw/` is machine data for diffing and AI indexing: lossless API responses, `documents.jsonl` (normalized records), `file-manifest.json`, extracted text under `content/text/`, `state.json`, and `unseen-changes.json`. Grades, submissions, quiz attempts and rosters are deliberately not collected. Inbox collection is limited to each course's conversations and never marks them read.
