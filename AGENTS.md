# Agent instructions

This repository has two distinct operating modes. Determine which mode the task belongs to before acting, and do not combine the modes unless the user explicitly asks for both.

Read [STYLE.md](STYLE.md) for code style. Put future code-style changes in `STYLE.md`, not in this file.

## Rules for every agent

- Never stage, unstage, commit, amend, reset, or otherwise manage Git state. Git staging and commits belong to the user.
- Never expose, copy, log, or persist Canvas credentials. Authentication is held outside this repository in the macOS Keychain.
- Never create, update, submit, grade, publish, or delete anything in Canvas. This project is read-only with respect to Canvas.
- Treat `raw/` as generated machine course data, the configured `viewDirectory` as the user-facing copied view, and `src/`, `test/`, `config.json`, and `known-content.json` as the archiver implementation.
- Preserve stable identifiers, source URLs, timestamps, hashes, and warning details. They are required for reliable diffs and indexing.
- Preserve and display external links found in Canvas content. If externally hosted content cannot be downloaded, the visible link is still part of the archive and indexing result.
- Read warning messages themselves; do not reduce them to warning counts.
- Interpret warnings in context. A warning is a coverage note, not automatically an archiver error or proof that content is missing.
- Do not restore or depend on the retired browser/AppleScript scraper or legacy verification artifacts.

## Mode A: repository maintainers

Use this mode when changing the archiver, configuration, tests, documentation, extraction, normalization, diffing, or archive layout.

### Source of truth

- `src/sync.ts`: Canvas collection and archive generation.
- `src/lib.ts`: normalization, hashing, text extraction, and comparison helpers.
- `config.json`: course scope and archive settings.
- `known-content.json`: direct Canvas identifiers used when list endpoints are unavailable.
- `test/`: regression tests.
- `README.md`: user-facing operation notes.

### Maintenance requirements

- Keep all Canvas operations read-only and use the pinned binary at `tools/canvas-cli/current/canvas`.
- Prefer structured JSON from Canvas and deterministic, atomic outputs.
- Optimize generated content for semantic diffing and AI indexing: stable ordering, stable IDs, normalized text, explicit metadata, and content hashes.
- Do not hand-edit generated files under `raw/` or the configured view directory. Change the generator and run a sync instead.
- Do not report removals for resource kinds whose collection was incomplete or warned.
- Keep full warning messages in human-readable reports, including the affected file ID and filename where available.
- Preserve valid existing downloads when Canvas temporarily stops providing a download URL. Never substitute an HTML error response for a PDF, Office document, or other attachment.
- A missing pages, quizzes, or similar collection may be normal for a course that does not use that Canvas feature. Preserve the warning, but do not describe it as missing course content without corroborating evidence from modules or known identifiers.
- A file record with no download URL is commonly gated or unreleased by teaching staff. Preserve its metadata, warn that its content is not currently downloadable, and retry it on later syncs.
- Avoid deleting raw content unless the user explicitly authorizes it and the exact targets have been verified.
- Do not add grades, submissions, quiz attempts, rosters, conversations, or other sensitive student data without explicit user direction.

### Verification

After implementation changes, run checks proportionate to the change:

```sh
bun test
bun run doctor
```

Run `bun run sync` only when a live, read-only refresh is needed. A successful sync should produce:

- `raw/INDEX.md`
- one `raw/<COURSE>/INDEX.md` per collected course
- normalized `documents.jsonl` records
- file manifests and extracted-text sidecars
- `raw/logs/latest.md` and `raw/logs/latest.json`

Review the actual warnings and the added/modified/removed diff before declaring success.

## Mode B: Canvas to Notion task tracker and NUS Exams calendar

Use this mode whenever the user asks for a Canvas to Notion update. Its purpose is to verify that Canvas task information is represented accurately and completely in **NUS Journey > Task Tracker** in Notion, enrich existing task pages with useful source information, and verify important one-time examinations in the **NUS Exams** Google Calendar.

### Operating boundary

- Treat Canvas and this repository as read-only sources.
- Treat Notion as read-mostly. The standing write permission covers the full body of an existing task page: add, rewrite, reorganize, or remove blocks as needed so the page is a clean, current reference for that module, tutorial, quiz, or assignment rather than a chronological update log.
- Treat every subpage nested within a Task Tracker page as the user's private handwritten notes. Do not open, search, read, edit, move, or delete these subpages or any of their contents. This restriction does not limit maintenance of the parent task page body.
- Do not change a Notion task date or other database property unless the user explicitly authorizes that property write for the current update. When authorized, write only dates confirmed by reliable Canvas course material and report every property changed.
- Do not create a missing task or alter database properties unless the user gives explicit permission for that specific action.
- Do not preserve superseded Canvas instructions merely as history. Replace or remove stale, duplicated, or contradicted task-page blocks when reliable current course material establishes the up-to-date content.
- Preserve user-authored personal notes and planning content unless they are plainly obsolete instructions copied from Canvas. If provenance or current accuracy is uncertain, leave the content in place and report it instead of removing it.
- Never delete a Notion page, database property, or content outside the body of a matched existing task page without the user's explicit approval. Absence from Canvas, a partial run, or a warning is never deletion approval.
- Deleted or archived Notion pages are entirely out of scope. Never fetch or inspect their bodies, compare their properties, follow their links, count them as current tasks, classify them as duplicates or extras, or mention them in Mode B reports. If a tool indicates that a page is deleted or archived, stop processing it immediately and do not unarchive it.
- Never write back to Canvas.
- Google Calendar access is limited to the calendar named **NUS Exams** and to important, one-time, high-weight examinations. Inspect it on every full update when calendar access is available.
- Create or update an **NUS Exams** event only when the user has authorized calendar writes and the date and time are confirmed by reliable course material. Never create an event from a TBA, ambiguous, internally inconsistent, or stale source.
- Do not use Google Calendar for assignments, quizzes, tutorials, diagnostics, study windows, or tasks that run over a period of time. Those belong in Notion.
- Never delete or cancel a calendar event without the user's explicit approval.
- Do not alter `raw/`, the configured view directory, implementation files, configuration, or logs, and do not run a live Canvas sync unless the user specifically asks for one.

### Sources and verification order

1. Inspect every in-scope module page in **NUS Journey > Module Planning** and read its **Canvas to Notion** section. Treat those notes as durable course-specific instructions for matching, ignored records, warning interpretation, and task behavior.
2. Enumerate only current, non-archived pages in **NUS Journey > Task Tracker**, preferably through a current database view or a query that explicitly excludes archived rows. Inspect every such task's module relation, title, date, and page body. Do not use module-relation targets as proof that a page is current: relations may retain references to deleted pages. If complete current-page enumeration is unavailable, limit the stated coverage instead of opening relation targets that may be deleted.
3. Inspect the **NUS Exams** Google Calendar for existing one-time examination events when calendar access is available and the user has not asked to omit calendar work.
4. Read `raw/logs/latest.json` for the Canvas run timestamp, course scope, collection completeness, and full warnings.
5. Read `raw/INDEX.md` for the corpus overview and assignment dates.
6. Read each in-scope `raw/<COURSE>/documents.jsonl` as the canonical normalized Canvas record stream.
7. Use `raw/<COURSE>/content/`, `raw/<COURSE>/content/text/files/`, and `file-manifest.json` when task instructions or attachment text are needed.
8. Use raw records only to resolve an ambiguity; do not use `raw/` as the default source.

Store new course-specific Mode B decisions on the applicable module page under **Canvas to Notion**, not in this file. Keep this file limited to the general workflow that ensures those notes are always read and followed.

If the user explicitly requests a fresh Canvas update, perform the authorized read-only refresh first, review its warnings, and then use the completed archive as the comparison source.

### Required audit on every update

Perform all of the following checks every time, even when the user asks generally for an "update":

1. **Date accuracy:** compare every current Notion task date with the applicable Canvas availability and due dates, including relevant student-specific overrides. Unless the user has authorized date writes for the current update, list every discrepancy without editing it. When date writes are authorized, update only confirmed dates and report what remains uncertain.
2. **Task completeness:** for each subject in scope, compare Canvas tasks against current, non-archived Task Tracker pages and identify every missing Notion task. Also flag uncertain matches, duplicates, or apparent extras among current pages separately; do not resolve them by creating tasks, changing database properties, or deleting pages. Ignore deleted or archived Notion pages completely, even when a surviving relation still references them.
3. **Page information:** inspect each matched task page and maintain its body as a concise, self-contained statement of the latest reliable Canvas information. Add missing details, rewrite outdated instructions, consolidate duplicates, and remove superseded Canvas-derived content. Useful information includes submission requirements, instructions, grading or rubric details, availability restrictions, required links, attachment summaries, and material changes that affect completing the task.
4. **Exam completeness:** compare important one-time, high-weight examinations against **NUS Exams**. Keep confirmed exams in Google Calendar rather than creating duplicate Notion tasks. Report missing, conflicting, or unconfirmed exam events.

Match records using stable Canvas identifiers or source URLs when available. Use title, subject, and date only as supporting evidence; never assume a title-only match is reliable.

Task completeness must inspect normalized `assignment` and `quiz` records and then inspect module, page, announcement, and syllabus records for corroborating evidence. Do not limit the audit to assignments. A dated mention in prose, a syllabus schedule, an external module link, or an archived module item is evidence to investigate, not by itself a current task to report or create. Promote such a reference to a current task only when a dedicated live Canvas assignment or quiz record, a current explicit announcement, or user confirmation establishes that it is active. Otherwise classify it as unverified reference or planning content and omit it from Mode B missing-task warnings.

Do not infer student visibility from a module or module-item `published` field alone. Cross-check it against any dedicated assignment or quiz record and `content_details`; if the flags are internally inconsistent, report the field as unreliable rather than declaring the content published or unpublished. Always verify the Notion module relation before accepting a title match, especially for repeated names such as tutorials, quizzes, lectures, and diagnostics.

When Canvas converts or replaces a record, apply any conversion rule recorded in the module's **Canvas to Notion** section before reporting a missing task, duplicate, extra, or removal. Preserve the existing Notion task when the course-specific rule says the new Canvas record is the continuation of it.

Inspect new and modified announcements for task-relevant changes. Incorporate useful current announcement details and source links into the corresponding existing task page after verifying the stable Canvas identifier or source URL and the Notion module relation. Replace any instructions that the announcement explicitly supersedes; do not retain the old version as a log. Do not attach an announcement to a task using title alone.

### Maintaining task-page information

- Make the existing task page body a concise, task-relevant, self-contained current reference. The reader should not need to reconstruct the latest instructions from a sequence of dated append-only updates.
- Freely add, edit, reorder, merge, or remove blocks within the matched task page body when reliable Canvas material establishes what is current.
- Preserve the Canvas source URL and important external links as clickable links with meaningful labels.
- Store availability windows and due dates in the `Due date` property when the user has authorized the property write. Do not duplicate those dates in the page body merely for indexing; keep body dates only when they are necessary to explain a policy, conflict, or sequence of requirements.
- Consolidate duplicate information and remove superseded Canvas-derived instructions rather than retaining a change log.
- Preserve useful user-authored personal notes and planning content. Integrate them cleanly with the current instructions when possible, but do not rewrite their meaning.
- Retain historical information only when it is still operationally relevant, such as a correction policy or a required sequence of earlier and later steps.
- Do not upload original course attachments unless the user explicitly authorizes the upload.
- If attachment text is unavailable, retain the available metadata or source link and state that the content could not be read; do not discard older instructions solely because an inaccessible attachment might supersede them.
- Use Canvas as the factual authority for Canvas task details. When Canvas and Notion conflict outside the date field, update clearly stale or wrong Canvas-derived task-page content. Leave ambiguous conflicts unchanged and report them.

### Partial coverage and warnings

- Limit completeness claims to courses covered by the latest completed Canvas run. An omitted course may be outside a partial run and must not be treated as empty or removed.
- Read warning messages themselves rather than relying on warning counts.
- A warning may represent an unused feature, access control, or unreleased content. Do not infer that a task is absent or deleted when relevant Canvas coverage is incomplete.
- Report uncertainty whenever warnings, gated content, missing download URLs, or ambiguous Notion matches prevent a reliable conclusion.
- Apply the warning interpretations recorded in each module page's **Canvas to Notion** section before producing the Mode B report. Expected unused Canvas features, unreleased files, and intentionally gated content must not be repeated as warnings when the module notes classify them as normal.
- If a raw warning omits the affected identifier or filename, resolve it from module references, known identifiers, file manifests, and preserved local files before reporting it. If it still cannot be resolved, say that the raw warning lacks the identifier rather than guessing.
- A relation or search result that points to a deleted or archived Notion page is not a coverage warning and must not be investigated or reported.
- If calendar access is unavailable or the user has asked to omit calendar work, skip it without treating that as a Mode B warning or incomplete Canvas/Notion coverage.

### Completion report

Use the following structure after every Canvas to Notion update:

1. Begin with one or two short prose sentences containing the Canvas run timestamp and subjects checked. Do not put either item in a list.
2. Add a short core-updates list containing only material findings or actions, such as newly released content added to a task page or a meaningful Canvas change that required verification. Omit routine audit confirmations from this list.
3. Add a **Still requiring review** list. Preserve this heading and list every unresolved date, uncertain item, relevant persistent warning, or other issue that needs the user's attention. Include intentionally retained warnings, such as stale source records that must continue to be monitored, in this list rather than in a separate warning paragraph.
4. Add a separate **Audit summary** list for routine confirmations, grouping together:
   - every missing, uncertain, duplicate, or extra task found by subject, or confirmation that none were found;
   - every Notion date property changed, or confirmation that no dates were modified when date writes were not authorized;
   - each task page materially rewritten or cleaned up, including the stale or duplicated content removed, or confirmation that none required cleanup;
   - anything created or otherwise updated in Notion outside the authorized task-page body maintenance;
   - confirmation that no pages, properties, or out-of-scope content were deleted.

The report must still cover roughly what information was added, rewritten, consolidated, or removed in existing task pages, every relevant Canvas warning or item that could not be verified, and any authorized **NUS Exams** work. If calendar work was unavailable or intentionally omitted, do not present that omission as a warning.
