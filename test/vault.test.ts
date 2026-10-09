import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyWarnings, describeChange, lineDiff, mergePending } from "../src/changes.ts";
import { documentRecord } from "../src/lib.ts";
import { courseTasks } from "../src/tasks.ts";
import type { CourseData, FileEntry, PendingChange } from "../src/types.ts";
import { planVault, vaultPathForDocument, writeVault } from "../src/vault.ts";

function course(overrides: Partial<CourseData> = {}): CourseData {
  return {
    configuredCourse: { code: "CS1", id: 1, name: "Course", knownContent: {} },
    course: { id: 1, name: "Course One" },
    modules: [],
    pages: [],
    assignments: [],
    assignmentGroups: [],
    assignmentOverrides: {},
    announcements: [],
    files: [],
    folders: [],
    quizzes: [],
    calendarEvents: [],
    inboxList: [],
    inbox: [],
    warnings: [],
    ...overrides,
  };
}

function fileEntry(id: number, name: string, status = "downloaded"): FileEntry {
  return {
    canvas_id: id,
    name,
    size: 4,
    content_type: "application/pdf",
    local_path: `content/files/${id}/${name}`,
    status,
    content_sha256: "hash",
    origin: "",
    legacy_preserved: null,
    text_path: "",
    text: { status: "not-requested", bytes: 0 },
  };
}

test("classic quizzes merge with their assignment and keep its overrides", () => {
  const data = course({
    quizzes: [{ id: 5, title: "Quiz 1", due_at: "0001-01-01T00:00:00Z" }],
    assignments: [
      { id: 50, name: "Quiz 1", assignment_group_id: 1, quiz_id: 5 },
      { id: 60, name: "Essay", assignment_group_id: 1, due_at: "2026-10-03T02:00:00Z" },
    ],
    assignmentOverrides: { 50: [{ id: 9, title: "L06", due_at: "2026-10-01T02:00:00Z" }] },
  });
  const tasks = courseTasks(data);
  assert.deepEqual(
    tasks.map((task) => [task.kind, task.id, task.assignment_id, task.due_at]),
    [
      ["quiz", 5, 50, null],
      ["assignment", 60, 60, "2026-10-03T02:00:00Z"],
    ],
  );
  assert.equal(tasks[0]?.overrides[0]?.audience, "L06");
});

test("vault plan uses clean names, Canvas folders and stable duplicates", () => {
  const data = course({
    folders: [
      { id: 1, name: "course files" },
      { id: 2, name: "Lecture #1", parent_folder_id: 1 },
    ],
    files: [
      { id: 10, folder_id: 2, size: 4 },
      { id: 11, folder_id: 2, size: 4 },
      { id: 12, folder_id: 99, size: 4 },
      { id: 13, folder_id: 2, size: 4, hidden_for_user: true },
    ],
    announcements: [{ id: 7, title: "Week 1", posted_at: "2026-08-10T16:30:00Z" }],
    assignments: [{ id: 3, name: "PE1", assignment_group_id: 1 }],
  });
  const plan = planVault(
    {
      data,
      rawDirectory: "/raw",
      fileEntries: [
        fileEntry(11, "slides.pdf"),
        fileEntry(10, "Slides.pdf"),
        fileEntry(12, "ps.pdf"),
        fileEntry(13, "image.png"),
        fileEntry(14, "gated.pdf", "download-failed"),
      ],
    },
    "Asia/Singapore",
  );
  assert.equal(plan.files.get(10), "Files/Lecture 1/Slides.pdf");
  assert.equal(plan.files.get(11), "Files/Lecture 1/slides (2).pdf");
  assert.equal(plan.files.get(12), "Files/ps.pdf");
  assert.equal(plan.files.get(13), "Attachments/image.png");
  assert.equal(plan.files.has(14), false);
  assert.equal(plan.announcements.get(7), "Announcements/2026-08-11 Week 1.md");
  assert.equal(vaultPathForDocument(plan, "CS1:assignment:3"), "CS1/Assignments/PE1.md");
});

test("vault notes link Canvas content to local files and drop stale generated files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-vault-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rawDirectory = path.join(root, "raw");
  const vault = path.join(root, "vault");
  await mkdir(path.join(rawDirectory, "content/files/10"), { recursive: true });
  await writeFile(path.join(rawDirectory, "content/files/10/SOP.pdf"), "%PDF");
  const data = course({
    files: [{ id: 10, size: 4 }],
    assignments: [
      {
        id: 3,
        name: "PE1",
        assignment_group_id: 1,
        due_at: "2026-10-03T02:00:00Z",
        description: '<p>Read the <a href="https://canvas.nus.edu.sg/courses/1/files/10?wrap=1">SOP</a>.</p>',
      },
    ],
    modules: [{ id: 1, name: "Week 1", items: [{ id: 1, type: "Assignment", title: "PE1", content_id: 3 }] }],
  });
  const vaultCourse = { data, rawDirectory, fileEntries: [fileEntry(10, "SOP.pdf")] };
  await writeVault(vault, "Asia/Singapore", vaultCourse, planVault(vaultCourse, "Asia/Singapore"));

  const note = await readFile(path.join(vault, "CS1/Assignments/PE1.md"), "utf8");
  assert.match(note, /^---\ncourse: "\[\[CS1\/CS1\|CS1\]\]"\ntype: "assignment"\ndue: 2026-10-03T10:00\n/);
  assert.match(note, /\[SOP\]\(\.\.\/Files\/SOP\.pdf\)/);
  assert.equal(await readFile(path.join(vault, "CS1/Files/SOP.pdf"), "utf8"), "%PDF");
  const courseNote = await readFile(path.join(vault, "CS1/CS1.md"), "utf8");
  assert.match(courseNote, /### Week 1\n\n- \[PE1\]\(Assignments\/PE1\.md\)/);
  assert.match(courseNote, /\| Sat, 3 Oct 2026 at 10:00 AM \| \[PE1\]\(Assignments\/PE1\.md\) \|/);

  data.assignments = [];
  data.modules = [];
  await writeVault(vault, "Asia/Singapore", vaultCourse, planVault(vaultCourse, "Asia/Singapore"));
  await assert.rejects(readFile(path.join(vault, "CS1/Assignments/PE1.md")));
});

function change(action: PendingChange["action"], before: string | null, after: string | null): PendingChange {
  const snapshot = (content: string) => {
    const document = documentRecord({ id: 1, kind: "page", course: "CS1", title: "Page", content });
    return { title: document.title, metadata: {}, content, content_sha256: document.content_sha256 };
  };
  return {
    action,
    document_id: "CS1:page:1",
    course: "CS1",
    kind: "page",
    title: "Page",
    vault_path: "",
    before: before === null ? null : snapshot(before),
    after: after === null ? null : snapshot(after),
  };
}

test("unseen changes compare against the last reviewed state", () => {
  const timezone = "Asia/Singapore";
  assert.deepEqual(mergePending([change("added", null, "a")], [change("removed", "a", null)], timezone), []);
  assert.deepEqual(mergePending([change("modified", "a", "b")], [change("modified", "b", "a")], timezone), []);
  const merged = mergePending([change("added", null, "a")], [change("modified", "a", "b")], timezone);
  assert.equal(merged[0]?.action, "added");
  assert.equal(merged[0]?.after?.content, "b");
});

test("modified content is described as a line diff and date changes are readable", () => {
  assert.deepEqual(lineDiff("one\ntwo\nthree", "one\n2\nthree\nfour"), ["+ 2", "- two", "+ four"]);
  const quiz: PendingChange = {
    ...change("modified", "same", "same"),
    kind: "quiz",
    before: { title: "Quiz", metadata: { due_at: "2026-10-03T02:00:00Z" }, content: "", content_sha256: "x" },
    after: { title: "Quiz", metadata: { due_at: "2026-10-04T02:00:00Z" }, content: "", content_sha256: "x" },
  };
  assert.deepEqual(describeChange(quiz, "Asia/Singapore"), [
    "due: Sat, 3 Oct 2026 at 10:00 AM → Sun, 4 Oct 2026 at 10:00 AM",
  ]);
});

test("expected Canvas warnings become coverage notes with file names", () => {
  const coverage = classifyWarnings(
    course({
      warnings: [
        { kind: "page-list", message: "pages.list: Not found: the requested resource does not exist" },
        { kind: "folder", id: "4", message: "folders.get: user not authorised to perform that action" },
        { kind: "file", id: "9", message: "9 — ps-06.pdf: files.download: file has no download URL" },
        { kind: "file", id: "8", message: "files.get: The specified resource does not exist." },
        { kind: "file", id: "8", message: "8 — notes.pdf: files.download: The specified resource does not exist." },
        { kind: "assignment-list", message: "assignments.list: timeout" },
      ],
      files: [{ id: 8, display_name: "notes.pdf", size: 1 }],
      pages: [{ url: "week-1", title: "Week 1", body: '<a href="/courses/1/files/8">notes</a>' }],
    }),
  );
  assert.deepEqual(coverage.notes, [
    "The Pages list is unavailable; pages linked from modules are still archived.",
    "The Files tab is restricted; files linked from modules and pages are still archived.",
    "Not released yet, retried every fetch: ps-06.pdf",
    "Linked but no longer on Canvas: notes.pdf (in Week 1)",
  ]);
  assert.deepEqual(
    coverage.warnings.map((warning) => warning.kind),
    ["assignment-list"],
  );
});
