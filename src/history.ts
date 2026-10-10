import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CourseCoverage } from "./changes.ts";
import { writeJson } from "./lib.ts";
import type { PendingChanges } from "./types.ts";

export interface HistoryRun extends PendingChanges {
  completed?: boolean;
  courses: Array<{ code: string; name: string; coverage: CourseCoverage }>;
}

interface HistoryStart {
  started_at: string;
  legacy: PendingChanges;
}

export interface History {
  start: HistoryStart;
  reviewed_through: string | null;
  runs: HistoryRun[];
}

async function read<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function reportTime(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("Report times must be ISO 8601 timestamps with a timezone, e.g. 2026-10-06T12:00:00+08:00");
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error(`Invalid report time: ${value}`);
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error(`Invalid report time: ${value}`);
  return time.toISOString();
}

export async function readHistory(raw: string): Promise<History | null> {
  const directory = path.join(raw, "history");
  const start = await read<HistoryStart>(path.join(directory, "start.json"));
  if (!start) return null;
  const runs: HistoryRun[] = [];
  for (const file of (await readdir(directory))
    .filter((file) => file.startsWith("fetch-") && file.endsWith(".json"))
    .sort()) {
    const run = await read<HistoryRun>(path.join(directory, file));
    if (!run) throw new Error(`Missing history run: ${file}`);
    runs.push(run);
  }
  return {
    start,
    reviewed_through: await read<string>(path.join(directory, "reviewed.json")),
    runs,
  };
}

export async function recordHistory(raw: string, legacy: PendingChanges, run: HistoryRun): Promise<void> {
  const directory = path.join(raw, "history");
  await mkdir(directory, { recursive: true });
  if (!(await read<HistoryStart>(path.join(directory, "start.json"))))
    await writeJson(path.join(directory, "start.json"), {
      started_at: legacy.last_sync ?? run.last_sync,
      legacy,
    });
  const suffix = run.completed ? "~complete" : `-${encodeURIComponent(run.courses[0]?.code ?? "course")}`;
  await writeJson(path.join(directory, `fetch-${run.last_sync?.replaceAll(":", "-")}${suffix}.json`), run);
}

export function historyReport(history: History, since?: string, through?: string): HistoryRun {
  const last = history.runs.at(-1)?.last_sync ?? history.start.legacy.last_sync;
  const end = through ? reportTime(through) : last;
  if (!end) throw new Error("No completed fetch is available to report");
  const start = since ? reportTime(since) : (history.reviewed_through ?? history.start.started_at);
  if (start < history.start.started_at)
    throw new Error(
      `Change history begins at ${history.start.started_at}; a complete report from ${start} is unavailable`,
    );
  if (start > end) throw new Error("Report start is after its end");
  if (last && end > last) throw new Error(`Report end is after the last completed fetch (${last})`);
  const inclusive = Boolean(since) || (!history.reviewed_through && !history.start.legacy.last_sync);
  const runs = history.runs.filter(
    (run) => run.last_sync && (inclusive ? run.last_sync >= start : run.last_sync > start) && run.last_sync <= end,
  );
  const legacy = !since && !history.reviewed_through ? history.start.legacy : null;
  const courses = new Map<string, HistoryRun["courses"][number]>();
  for (const run of history.runs.filter((run) => run.last_sync && run.last_sync <= end))
    for (const course of run.courses) courses.set(course.code, course);
  return {
    completed: history.runs.filter((run) => run.last_sync && run.last_sync <= end).at(-1)?.completed ?? false,
    since: legacy?.since ?? start,
    last_sync: end,
    first_syncs: [...new Set([...(legacy?.first_syncs ?? []), ...runs.flatMap((run) => run.first_syncs)])],
    changes: [...(legacy?.changes ?? []), ...runs.flatMap((run) => run.changes)],
    courses: [...courses.values()],
  };
}

export async function reviewHistory(raw: string, through: string): Promise<void> {
  const history = await readHistory(raw);
  if (!history) throw new Error("No change history is available");
  const time = reportTime(through);
  if (history.runs.at(-1)?.last_sync !== time)
    throw new Error("Canvas was fetched after that report; reprint it with `bun run changes` first");
  if (history.reviewed_through && time < history.reviewed_through)
    throw new Error("Cannot move the review cursor backwards");
  // Fetches only add run files; acknowledging a report cannot overwrite a concurrent fetch's history.
  await writeJson(path.join(raw, "history", "reviewed.json"), time);
}
