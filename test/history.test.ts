import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderReport } from "../src/changes.ts";
import {
  type HistoryRun,
  historyReport,
  readHistory,
  recordHistory,
  reportTime,
  reviewHistory,
  startHistory,
} from "../src/history.ts";
import type { PendingChange } from "../src/types.ts";

const baseline = "2026-10-06T04:00:00.000Z";
const first = "2026-10-06T05:00:00.000Z";
const second = "2026-10-06T06:00:00.000Z";
const third = "2026-10-06T07:00:00.000Z";
const courses = [{ code: "CS1", name: "Course", coverage: { notes: [], warnings: [] } }];

function change(before: string | null, after: string | null): PendingChange {
  const snapshot = (content: string | null) =>
    content === null ? null : { title: "Page", content, content_sha256: content, metadata: {} };
  return {
    document_id: "CS1:page:1",
    course: "CS1",
    kind: "page",
    title: "Page",
    action: before === null ? "added" : after === null ? "removed" : "modified",
    vault_path: "CS1/Pages/Page.md",
    source_url: "https://canvas.example/courses/1/pages/page",
    before: snapshot(before),
    after: snapshot(after),
  };
}

function run(time: string, changes: PendingChange[]): HistoryRun {
  return {
    since: null,
    last_sync: time,
    first_syncs: [],
    changes: changes.map((change) => ({ ...change, observed_at: time })),
    courses,
    completed: true,
  };
}

async function fixture(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-history-"));
  try {
    await startHistory(directory, baseline);
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("history preserves additions, removals, edits and reversals across reports", async () => {
  await fixture(async (directory) => {
    await recordHistory(directory, run(first, [change(null, "a"), change("original", "edited")]));
    await recordHistory(directory, run(second, [change("a", null), change("edited", "original")]));
    const history = await readHistory(directory);
    assert.ok(history);
    const report = historyReport(history, "2026-10-06T12:00:00+08:00");
    assert.deepEqual(
      report.changes.map((change) => change.action),
      ["added", "modified", "removed", "modified"],
    );
    assert.equal(report.changes[0]?.source_url, "https://canvas.example/courses/1/pages/page");
    const rendered = renderReport(report, report.courses, "Asia/Singapore");
    assert.match(rendered, /observed/);
    assert.match(rendered, /\+ edited/);
    assert.match(rendered, /\+ original/);
    await reviewHistory(directory, second);
    const reviewed = await readHistory(directory);
    assert.ok(reviewed);
    assert.equal(historyReport(reviewed).changes.length, 0);
    assert.equal(historyReport(reviewed, baseline).changes.length, 4);
    await recordHistory(directory, run(third, [change("original", "next")]));
    const newer = await readHistory(directory);
    assert.ok(newer);
    assert.deepEqual(
      historyReport(newer).changes.map((change) => change.after?.content),
      ["next"],
    );
    assert.equal(newer.runs.length, 3);
  });
});

test("explicit windows are inclusive at the start and preserve snapshots through the end", async () => {
  await fixture(async (directory) => {
    await recordHistory(directory, run(first, [change("old", "new")]));
    await recordHistory(directory, run(second, [change("new", "newer")]));
    const history = await readHistory(directory);
    assert.ok(history);
    assert.equal(historyReport(history, first, first).changes[0]?.after?.content, "new");
    assert.equal(historyReport(history, second).changes.length, 1);
    assert.throws(() => historyReport(history, "2026-10-05T00:00:00Z"), /history begins/);
    assert.throws(() => historyReport(history, third), /start is after/);
    assert.throws(() => historyReport(history, baseline, third), /last completed fetch/);
    await assert.rejects(reviewHistory(directory, first), /fetched after/);
    assert.equal((await readHistory(directory))?.reviewed_through, null);
  });
});

test("explicit dates use Canvas update times while default reports retain late discoveries", async () => {
  await fixture(async (directory) => {
    const edited = change("old", "new");
    assert.ok(edited.before && edited.after);
    edited.before.updated_at = baseline;
    edited.after.updated_at = first;
    await recordHistory(directory, run(second, [edited]));
    const history = await readHistory(directory);
    assert.ok(history);
    assert.equal(historyReport(history, first).changes.length, 1);
    assert.equal(historyReport(history, second).changes.length, 0);
    // A historical endpoint cannot include data collected after that endpoint.
    assert.equal(historyReport(history, first, first).changes.length, 0);
    await reviewHistory(directory, second);
    await recordHistory(directory, run(third, [edited]));
    const reviewed = await readHistory(directory);
    assert.ok(reviewed);
    assert.equal(historyReport(reviewed).changes.length, 1);
    assert.equal(historyReport(reviewed, second).changes.length, 0);
    assert.match(renderReport(historyReport(reviewed), courses, "Asia/Singapore"), /Canvas updated/);
  });
});

test("removals and changes with missing, unchanged or invalid Canvas dates use detection time", async () => {
  await fixture(async (directory) => {
    const unchanged = change("unreleased", "released");
    assert.ok(unchanged.before && unchanged.after);
    unchanged.before.updated_at = baseline;
    unchanged.after.updated_at = baseline;
    const invalid = change(null, "invalid");
    assert.ok(invalid.after);
    invalid.after.updated_at = "invalid";
    const future = change(null, "future");
    assert.ok(future.after);
    future.after.updated_at = third;
    await recordHistory(
      directory,
      run(second, [change("old", null), change(null, "missing"), unchanged, invalid, future]),
    );
    const history = await readHistory(directory);
    assert.ok(history);
    assert.equal(historyReport(history, second).changes.length, 5);
    assert.equal(historyReport(history, baseline, first).changes.length, 0);
  });
});

test("new history starts fresh without importing old pending differences", async () => {
  await fixture(async (directory) => {
    await writeFile(
      path.join(directory, "unseen-changes.json"),
      JSON.stringify({
        since: "2026-10-01T00:00:00Z",
        last_sync: baseline,
        changes: [change("before", "after")],
        first_syncs: [],
      }),
    );
    await startHistory(directory, first);
    await recordHistory(directory, run(first, []));
    const history = await readHistory(directory);
    assert.ok(history);
    assert.equal(history.start.started_at, baseline);
    assert.equal(historyReport(history).changes.length, 0);
    assert.equal("legacy" in history.start, false);
  });
});

test("fresh baselines and incomplete fetches remain visible without losing earlier course coverage", async () => {
  await fixture(async (directory) => {
    await recordHistory(directory, { ...run(first, []), first_syncs: ["CS1"] });
    await recordHistory(directory, {
      ...run(second, [change(null, "new")]),
      completed: false,
      courses: [{ code: "CS2", name: "Other", coverage: { notes: [], warnings: [] } }],
    });
    const history = await readHistory(directory);
    assert.ok(history);
    const report = historyReport(history);
    assert.deepEqual(report.first_syncs, ["CS1"]);
    assert.deepEqual(
      report.courses.map((course) => course.code),
      ["CS1", "CS2"],
    );
    assert.equal(report.completed, false);
    assert.equal(report.changes.length, 1);
  });
});

test("history corruption fails visibly and review acknowledgement leaves run files intact", async () => {
  await fixture(async (directory) => {
    await recordHistory(directory, run(first, [change("old", "new")]));
    const file = path.join(directory, "history", "fetch-2026-10-06T05-00-00.000Z~complete.json");
    const before = await readFile(file, "utf8");
    await reviewHistory(directory, first);
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "broken JSON");
    await assert.rejects(readHistory(directory), SyntaxError);
  });
});

test("report timestamps require explicit zones and valid dates", () => {
  assert.equal(reportTime("2026-10-06T12:00:00+08:00"), baseline);
  for (const value of [undefined, "2026-10-06", "2026-10-06T12:00:00", "2026-02-30T12:00:00Z", "invalid"])
    assert.throws(() => reportTime(value));
});

test("course checkpoints cannot be overwritten by a completion marker at the same millisecond", async () => {
  await fixture(async (directory) => {
    await recordHistory(directory, { ...run(first, [change("old", "new")]), completed: false });
    await recordHistory(directory, run(first, []));
    const history = await readHistory(directory);
    assert.ok(history);
    assert.equal(history.runs.length, 2);
    assert.equal(historyReport(history).changes.length, 1);
    assert.equal(historyReport(history).completed, true);
  });
});

test("the CLI selects historical windows and acknowledging a report does not erase them", async () => {
  await fixture(async (directory) => {
    await cp(path.resolve(import.meta.dir, "../src"), path.join(directory, "src"), { recursive: true });
    await symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(directory, "node_modules"));
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ courses: [], timezone: "Asia/Singapore" }));
    const raw = path.join(directory, "raw");
    await startHistory(raw, baseline);
    await recordHistory(raw, run(first, [change("old", "new")]));
    await recordHistory(raw, run(second, [change("new", "old")]));
    const cli = async (...options: string[]) => {
      const process = Bun.spawn(
        [Bun.which("bun") ?? "bun", path.join(directory, "src/sync.ts"), "changes", ...options],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { stdout, stderr, code };
    };
    const selected = await cli("--since", "2026-10-06T13:00:00+08:00", "--through", first);
    assert.equal(selected.code, 0, selected.stderr);
    assert.match(selected.stdout, /\+ new/);
    assert.doesNotMatch(selected.stdout, /\+ old/);
    assert.ok(selected.stdout.includes(`Report through: ${first}`));
    assert.equal((await readHistory(raw))?.reviewed_through, null);
    assert.notEqual((await cli("--reviewed")).code, 0);
    assert.notEqual((await cli("--since")).code, 0);
    assert.notEqual((await cli("--reviewed", "--through", first)).code, 0);
    assert.equal((await cli("--reviewed", "--through", second)).code, 0);
    assert.doesNotMatch((await cli()).stdout, /\+ (new|old)/);
    assert.match((await cli("--since", baseline)).stdout, /\+ old/);
    const unavailable = await cli("--since", "2026-10-05T00:00:00Z");
    assert.notEqual(unavailable.code, 0);
    assert.match(unavailable.stderr, /history begins/);
  });
});

test("fetch establishes fresh baselines over existing archives, then records subsequent Canvas edits", async () => {
  await fixture(async (directory) => {
    await cp(path.resolve(import.meta.dir, "../src"), path.join(directory, "src"), { recursive: true });
    await symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(directory, "node_modules"));
    const binary = path.join(directory, "canvas-fixture");
    const page = path.join(directory, "page.json");
    await writeFile(
      binary,
      `#!${Bun.which("bun")}
import { readFileSync } from "node:fs";
const command = process.argv[2];
const data = command === "courses"
  ? { id: 1, name: "Course", course_code: "CS1", html_url: "https://canvas.example/courses/1" }
  : command === "pages" ? [JSON.parse(readFileSync(${JSON.stringify(page)}, "utf8"))]
  : command === "api" ? { body: [] } : [];
process.stdout.write(JSON.stringify(data));
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        canvasBinary: binary,
        canvasInstance: "fixture",
        timezone: "Asia/Singapore",
        courses: [{ id: 1, code: "CS1", name: "Course" }],
        downloadFiles: false,
        extractText: false,
      }),
    );
    const update = (body: string) =>
      writeFile(
        page,
        JSON.stringify({
          page_id: 1,
          url: "page",
          title: "Page",
          body,
          updated_at: new Date().toISOString(),
          html_url: "https://canvas.example/courses/1/pages/page",
        }),
      );
    const fetch = async () => {
      const process = Bun.spawn([Bun.which("bun") ?? "bun", path.join(directory, "src/sync.ts"), "fetch"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      assert.equal(code, 0, stderr);
      return stdout;
    };
    const raw = path.join(directory, "raw");
    await update("Before deployment");
    await fetch();
    // Simulate upgrading an existing archive that has no retained history yet.
    await rm(path.join(raw, "history"), { recursive: true });
    await writeFile(
      path.join(raw, "unseen-changes.json"),
      JSON.stringify({
        since: baseline,
        last_sync: first,
        first_syncs: [],
        changes: [change("old", "pending")],
      }),
    );
    await update("Deployment baseline");
    assert.match(await fetch(), /baseline/);
    const initialized = await readHistory(raw);
    assert.ok(initialized);
    assert.ok(initialized.start.started_at > first);
    assert.equal(historyReport(initialized).changes.length, 0);
    assert.deepEqual(historyReport(initialized).first_syncs, ["CS1"]);
    const endpoint = initialized.runs.at(-1)?.last_sync;
    assert.ok(endpoint);
    await reviewHistory(raw, endpoint);
    await update("After deployment");
    await fetch();
    const changed = await readHistory(raw);
    assert.ok(changed);
    const report = historyReport(changed);
    assert.equal(report.changes.length, 1);
    assert.equal(report.changes[0]?.kind, "page");
    assert.match(report.changes[0]?.before?.content ?? "", /Deployment baseline/);
    assert.match(report.changes[0]?.after?.content ?? "", /After deployment/);
    assert.ok(report.changes[0]?.after?.updated_at);
    assert.equal(historyReport(changed, initialized.start.started_at).changes.length, 1);
    assert.deepEqual(report.courses[0]?.coverage, { notes: [], warnings: [] });
  });
});
