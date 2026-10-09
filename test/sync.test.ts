import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canvasApiBody, canvasError, collectApiResource } from "../src/canvas-client.ts";
import { loadConfig, resolvePath } from "../src/config.ts";
import {
  assignmentDates,
  conversationBelongsToCourse,
  embeddedFileIds,
  forwardedMessageContent,
  inboxConversationOrder,
  inboxDetailArgs,
  inboxListArgs,
  incompleteDocumentKinds,
  parseOptions,
  sanitizeCanvasSecrets,
} from "../src/sync.ts";
import type { CanvasWarning } from "../src/types.ts";

test("Canvas secrets are redacted recursively without changing other values", () => {
  const input = {
    url: "https://canvas.example/file?verifier=secret&download=1",
    nested: ["https://canvas.example?access_token=token", "https://canvas.example?verifier=secret\\tail", 42],
  };
  assert.deepEqual(sanitizeCanvasSecrets(input), {
    url: "https://canvas.example/file?verifier=<redacted>&download=1",
    nested: ["https://canvas.example?access_token=<redacted>", "https://canvas.example?verifier=<redacted>", 42],
  });
});

test("structured Canvas errors are recovered from mixed stderr output", () => {
  const error = { stderr: 'diagnostic\n{"command":"files.download","error":"not available"}\n' };
  assert.deepEqual(canvasError(error), {
    raw: 'diagnostic\n{"command":"files.download","error":"not available"}',
    structured: { command: "files.download", error: "not available" },
  });
});

test("raw Canvas API responses expose their body", () => {
  assert.deepEqual(canvasApiBody({ body: [{ id: 1 }] }), [{ id: 1 }]);
  assert.throws(() => canvasApiBody({ status_code: 200 }), /did not contain a body/);
});

test("null Canvas API lists use the fallback while nullable details remain null", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-null-list-"));
  try {
    const binary = path.join(directory, "canvas");
    await writeFile(binary, "#!/bin/sh\nprintf '%s\\n' '{\"body\":null,\"status_code\":200}'\n", { mode: 0o755 });
    await copyFile(path.resolve(import.meta.dir, "../config.example.json"), path.join(directory, "config.json"));
    const config = await loadConfig(directory);
    config.canvasBinary = binary;
    const warnings: CanvasWarning[] = [];
    assert.deepEqual(await collectApiResource(config, warnings, "inbox-list", inboxListArgs(93575)), []);
    assert.equal(await collectApiResource(config, warnings, "inbox", inboxDetailArgs(42), null), null);
    assert.deepEqual(warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project paths resolve consistently", () => {
  assert.equal(resolvePath("./raw", "/project"), path.normalize("/project/raw"));
  assert.equal(resolvePath("/archive/raw", "/project"), path.normalize("/archive/raw"));
});

test("embedded file IDs are discovered and deduplicated", () => {
  assert.deepEqual([...embeddedFileIds({ body: "/files/42", nested: ["/files/7", "/files/42"] })], [42, 7]);
});

test("assignment dates retain course and override audiences", () => {
  assert.deepEqual(
    assignmentDates({ due_at: "2026-08-20", unlock_at: null, lock_at: null }, [
      {
        id: 9,
        title: "Tutorial group",
        due_at: "2026-08-21",
        student_ids: [1, 2],
      },
    ]),
    [
      {
        audience: "Course",
        due_at: "2026-08-20",
        unlock_at: null,
        lock_at: null,
      },
      {
        audience: "Tutorial group",
        due_at: "2026-08-21",
        unlock_at: undefined,
        lock_at: undefined,
        override_id: 9,
        course_section_id: null,
        group_id: null,
        student_ids: [1, 2],
      },
    ],
  );
});

test("collection warnings map to the affected document kinds", () => {
  assert.deepEqual(
    incompleteDocumentKinds([
      { kind: "page-list" },
      { kind: "assignment-list" },
      { kind: "file" },
      { kind: "file-list" },
      { kind: "inbox" },
    ]),
    ["page", "assignment", "file", "inbox"],
  );
});

test("Inbox conversations require matching explicit course attribution", () => {
  assert.equal(conversationBelongsToCourse({ context_code: "course_94109" }, 94109), true);
  assert.equal(conversationBelongsToCourse({ audience_contexts: { course_94109: [1] } }, 94109), true);
  assert.equal(conversationBelongsToCourse({ audience_contexts: { courses: { "94109": [1] } } }, 94109), true);
  assert.equal(conversationBelongsToCourse({ context_code: "course_99999" }, 94109), false);
  assert.equal(conversationBelongsToCourse({ subject: "No explicit context" }, 94109), true);
});

test("Inbox collection bypasses the broken typed conversation decoder", () => {
  assert.deepEqual(inboxListArgs(94109), [
    "api",
    "GET",
    "/api/v1/conversations",
    "--paginate",
    "--query",
    "filter[]=course_94109",
  ]);
  assert.deepEqual(inboxDetailArgs(42), [
    "api",
    "GET",
    "/api/v1/conversations/42",
    "--query",
    "auto_mark_as_read=false",
  ]);
});

test("Inbox conversations sort oldest first with stable ID tie-breaking", () => {
  const conversations = [
    { id: 3, last_message_at: "2026-09-17T03:00:00Z" },
    { id: 2, last_message_at: "2026-09-16T03:00:00Z" },
    { id: 1, last_message_at: "2026-09-16T03:00:00Z" },
  ];
  assert.deepEqual(
    conversations.sort(inboxConversationOrder).map(({ id }) => id),
    [1, 2, 3],
  );
});

test("forwarded Inbox messages render recursively in oldest-first order with attachments", () => {
  const content = forwardedMessageContent([
    {
      body: "new",
      attachments: [{ filename: "new.pdf", url: "https://canvas.example/new.pdf" }],
      media_comment: { display_name: "Recording", url: "https://canvas.example/media" },
    },
    { body: "old", forwarded_messages: [{ body: "nested" }] },
  ]);
  assert.ok(content.indexOf("old") < content.indexOf("nested"));
  assert.ok(content.indexOf("nested") < content.indexOf("new"));
  assert.match(content, /\[new\.pdf\]\(https:\/\/canvas\.example\/new\.pdf\)/);
  assert.match(content, /\[Recording\]\(https:\/\/canvas\.example\/media\)/);
});

test("sync options select a course and honor metadata-only mode", () => {
  const config = {
    courses: [{ code: "CS1" }, { code: "CS2" }],
    downloadFiles: true,
    extractText: true,
  };
  assert.deepEqual(parseOptions(config, ["--course", "cs2", "--metadata-only"]), {
    courses: [{ code: "CS2" }],
    downloadFiles: false,
    extractText: false,
  });
  assert.throws(() => parseOptions(config, ["--course", "missing"]), /Unknown course: MISSING/);
});
