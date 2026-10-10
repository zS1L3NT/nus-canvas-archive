import { canvasDate, displayDate, stableJson } from "./lib.ts";
import type {
  ArchiveChange,
  ArchiveDocument,
  ArchiveState,
  CanvasWarning,
  ChangeSnapshot,
  CourseData,
  PendingChange,
  PendingChanges,
} from "./types.ts";

const kindOrder = ["announcement", "inbox", "assignment", "quiz", "calendar", "page", "module", "file", "course"];
const kindLabels: Record<string, string> = {
  announcement: "Announcement",
  assignment: "Assignment",
  calendar: "Event",
  course: "Syllabus",
  file: "File",
  inbox: "Message",
  module: "Module",
  page: "Page",
  quiz: "Quiz",
};
const diffLimit = 25;

function snapshot(document?: ArchiveDocument, state?: ArchiveState[string]): ChangeSnapshot | null {
  const source = document ?? state;
  if (!source) return null;
  return {
    title: source.title,
    metadata: source.metadata,
    // Extracted file text is too large to keep; file changes are described by hash and size.
    content: document && document.kind !== "file" ? document.content : null,
    content_sha256: source.content_sha256,
  };
}

export function pendingFromRun(
  changes: ArchiveChange[],
  previous: { documents: Map<string, ArchiveDocument>; state: ArchiveState },
  current: Map<string, ArchiveDocument>,
  vaultPath: (documentId: string, metadata: Record<string, unknown>) => string,
): PendingChange[] {
  return changes.map((change) => {
    const before =
      change.action === "added"
        ? null
        : snapshot(previous.documents.get(change.document_id), previous.state[change.document_id]);
    const after = change.action === "removed" ? null : snapshot(current.get(change.document_id));
    return {
      action: change.action,
      document_id: change.document_id,
      course: change.document_id.split(":")[0] ?? "",
      kind: change.kind,
      title: change.title,
      vault_path: change.action === "removed" ? "" : vaultPath(change.document_id, after?.metadata ?? {}),
      before,
      after,
    };
  });
}

// Folds a new run into the unseen list, always comparing against the state at the last review.
export function mergePending(existing: PendingChange[], incoming: PendingChange[], timezone: string): PendingChange[] {
  const merged = new Map(existing.map((change) => [change.document_id, change]));
  for (const change of incoming) {
    const old = merged.get(change.document_id);
    if (!old) {
      merged.set(change.document_id, change);
      continue;
    }
    const before = old.before;
    const after = change.after;
    if (!before && !after) {
      merged.delete(change.document_id);
      continue;
    }
    merged.set(change.document_id, {
      ...change,
      action: !before ? "added" : !after ? "removed" : "modified",
      before,
      after,
    });
  }
  return [...merged.values()]
    .filter((change) => change.action !== "modified" || describeChange(change, timezone).length)
    .sort((left, right) => left.document_id.localeCompare(right.document_id));
}

function dateFields(kind: string, metadata: Record<string, unknown>): Map<string, string> {
  const fields = new Map<string, string>();
  const add = (label: string, value: unknown) => fields.set(label, String(canvasDate(value) ?? ""));
  if (kind === "assignment") {
    for (const date of (metadata.dates as Array<Record<string, unknown>> | undefined) ?? []) {
      const prefix = date.audience === "Course" ? "" : `${date.audience} `;
      add(`${prefix}due`, date.due_at);
      add(`${prefix}opens`, date.unlock_at);
      add(`${prefix}closes`, date.lock_at);
    }
  } else if (kind === "quiz") {
    add("due", metadata.due_at);
    add("opens", metadata.unlock_at);
    add("closes", metadata.lock_at);
  } else if (kind === "calendar") {
    add("starts", metadata.start_at);
    add("ends", metadata.end_at);
    fields.set("location", String(metadata.location_name ?? ""));
  }
  return fields;
}

function fileSize(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function lineDiff(before: string, after: string): string[] {
  const left = before.split("\n").filter((line) => line.trim());
  const right = after.split("\n").filter((line) => line.trim());
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const removed = left.slice(start, leftEnd);
  const added = right.slice(start, rightEnd);
  if (removed.length * added.length > 250_000)
    return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
  // Longest common subsequence over the changed middle keeps unchanged lines out of the report.
  const width = added.length + 1;
  const lengths = new Uint32Array((removed.length + 1) * width);
  const at = (i: number, j: number) => lengths[i * width + j] ?? 0;
  for (let i = removed.length - 1; i >= 0; i -= 1)
    for (let j = added.length - 1; j >= 0; j -= 1)
      lengths[i * width + j] = removed[i] === added[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length || j < added.length) {
    if (i < removed.length && j < added.length && removed[i] === added[j]) {
      i += 1;
      j += 1;
    } else if (j < added.length && (i >= removed.length || at(i, j + 1) >= at(i + 1, j))) {
      lines.push(`+ ${added[j]}`);
      j += 1;
    } else {
      lines.push(`- ${removed[i]}`);
      i += 1;
    }
  }
  return lines;
}

export function describeChange(change: PendingChange, timezone: string): string[] {
  const { before, after } = change;
  if (!before || !after) return [];
  const lines: string[] = [];
  if (before.title !== after.title) lines.push(`renamed from “${before.title}”`);
  const beforeDates = dateFields(change.kind, before.metadata);
  const afterDates = dateFields(change.kind, after.metadata);
  for (const label of new Set([...beforeDates.keys(), ...afterDates.keys()])) {
    const old = beforeDates.get(label) ?? "";
    const next = afterDates.get(label) ?? "";
    if (old === next) continue;
    const show = (value: string) => (label === "location" ? value : displayDate(value, timezone)) || "none";
    lines.push(`${label}: ${show(old)} → ${show(next)}`);
  }
  if (stableJson(before.metadata.points_possible) !== stableJson(after.metadata.points_possible))
    lines.push(`points: ${before.metadata.points_possible ?? "none"} → ${after.metadata.points_possible ?? "none"}`);
  if (change.kind === "file") {
    if (before.metadata.content_sha256 !== after.metadata.content_sha256)
      lines.push(
        before.metadata.content_sha256
          ? `new version of the file (${fileSize(before.metadata.size)} → ${fileSize(after.metadata.size)})`
          : "now available to download",
      );
  } else if (before.content_sha256 !== after.content_sha256) {
    if (before.content === null || after.content === null) lines.push("content changed");
    else {
      const strip = (text: string) =>
        change.kind === "module" ? text.replace(/[ \t]+https?:\/\/\S+$/gm, "").replace(/^\s*- /gm, "") : text;
      lines.push(...lineDiff(strip(before.content), strip(after.content)));
    }
  }
  return lines;
}

function excerpt(content: string | null | undefined, length = 280): string {
  const text = String(content ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}

function addedDetail(change: PendingChange, timezone: string): string {
  const metadata = change.after?.metadata ?? {};
  if (change.kind === "assignment") {
    const due = (metadata.dates as Array<{ due_at?: string }> | undefined)?.find((date) => canvasDate(date.due_at));
    return due ? ` · due ${displayDate(due.due_at, timezone)}` : "";
  }
  if (change.kind === "quiz")
    return canvasDate(metadata.due_at) ? ` · due ${displayDate(metadata.due_at, timezone)}` : "";
  if (change.kind === "announcement") return ` · posted ${displayDate(metadata.posted_at, timezone)}`;
  if (change.kind === "calendar") return ` · ${displayDate(metadata.start_at, timezone)}`;
  if (change.kind === "file")
    return metadata.content_sha256 ? ` · ${fileSize(metadata.size)}` : " · not downloadable yet";
  return "";
}

// Announcements and messages read best in the order they were posted.
function postedAt(change: PendingChange): string {
  const metadata = (change.after ?? change.before)?.metadata ?? {};
  return String(metadata.posted_at ?? metadata.last_message_at ?? "");
}

export interface CourseCoverage {
  notes: string[];
  warnings: CanvasWarning[];
}

// Canvas reports unused features, restricted tabs and unreleased files as errors; those are coverage notes.
export function classifyWarnings(
  data: Pick<
    CourseData,
    "warnings" | "files" | "modules" | "pages" | "assignments" | "announcements" | "quizzes" | "course"
  >,
): CourseCoverage {
  const notes = new Set<string>();
  const unreleased = new Map<string, string>();
  const missing = new Map<string, string>();
  const unexpected: CanvasWarning[] = [];
  const names = new Map(data.files.map((file) => [String(file.id), file.display_name || file.filename || ""]));
  const linkedFrom = (id: string): string[] => {
    const titles = data.modules.flatMap((module) =>
      (module.items || []).filter((item) => String(item.content_id) === id).map(() => String(module.name).trim()),
    );
    const bodies: Array<[string, unknown]> = [
      ["Syllabus", data.course.syllabus_body],
      ...data.pages.map((page): [string, unknown] => [page.title, page.body]),
      ...data.assignments.map((assignment): [string, unknown] => [assignment.name, assignment.description]),
      ...data.announcements.map((announcement): [string, unknown] => [announcement.title, announcement.message]),
      ...data.quizzes.map((quiz): [string, unknown] => [quiz.title, quiz.description]),
    ];
    for (const [title, body] of bodies) if (String(body ?? "").includes(`/files/${id}`)) titles.push(title);
    return [...new Set(titles)];
  };
  for (const warning of data.warnings) {
    const message = String(warning.message);
    const id = warning.id ?? message.match(/^(\d+) — /)?.[1];
    const label = () => {
      const sources = id ? linkedFrom(id) : [];
      const name =
        (id && names.get(id)) || message.match(/^\d+ — (.+?): files\.download:/)?.[1] || `file ${id ?? "with no ID"}`;
      return `${name}${sources.length ? ` (in ${sources.join(", ")})` : ""}`;
    };
    if (["page-list", "quiz-list"].includes(warning.kind) && /not found/i.test(message))
      notes.add(
        warning.kind === "page-list"
          ? "The Pages list is unavailable; pages linked from modules are still archived."
          : "Quizzes are not enabled.",
      );
    else if (["file-list", "folder"].includes(warning.kind) && /not authori[sz]ed/i.test(message))
      notes.add("The Files tab is restricted; files linked from modules and pages are still archived.");
    else if (warning.kind === "file" && /no download URL/i.test(message)) unreleased.set(id ?? message, label());
    else if (warning.kind === "file" && /does not exist/i.test(message)) missing.set(id ?? message, label());
    else unexpected.push(warning);
  }
  if (unreleased.size) notes.add(`Not released yet, retried every fetch: ${[...unreleased.values()].join("; ")}`);
  if (missing.size) notes.add(`Linked but no longer on Canvas: ${[...missing.values()].join("; ")}`);
  return { notes: [...notes], warnings: unexpected };
}

export function renderReport(
  pending: PendingChanges,
  courses: Array<{ code: string; name: string; coverage: CourseCoverage }>,
  timezone: string,
): string {
  const lines = [
    "# Canvas changes",
    "",
    pending.since
      ? `Unreviewed since ${displayDate(pending.since, timezone)} · last fetch ${displayDate(pending.last_sync, timezone)}`
      : `Last fetch ${displayDate(pending.last_sync, timezone)}`,
    "",
  ];
  const quiet: string[] = [];
  for (const course of courses) {
    const changes = pending.changes
      .filter((change) => change.course === course.code)
      .sort(
        (left, right) =>
          kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
          postedAt(left).localeCompare(postedAt(right)) ||
          left.title.localeCompare(right.title, "en"),
      );
    const firstSync = pending.first_syncs.includes(course.code);
    if (!changes.length && !firstSync && !course.coverage.warnings.length) {
      quiet.push(course.code);
      continue;
    }
    lines.push(`## ${course.code} · ${course.name}`, "");
    if (firstSync) lines.push("First fetch: everything was archived as a baseline.", "");
    for (const [action, heading] of [
      ["added", "New"],
      ["modified", "Updated"],
      ["removed", "Removed"],
    ] as const) {
      const matching = changes.filter((change) => change.action === action);
      if (!matching.length) continue;
      lines.push(`### ${heading}`, "");
      for (const change of matching) {
        const where = change.vault_path ? ` → \`${change.vault_path}\`` : "";
        const detail = action === "added" ? addedDetail(change, timezone) : "";
        lines.push(`- ${kindLabels[change.kind] ?? change.kind} **${change.title.trim()}**${detail}${where}`);
        if (action === "added" && ["announcement", "inbox"].includes(change.kind) && change.after?.content)
          lines.push(`  > ${excerpt(change.after.content)}`);
        if (action !== "modified") continue;
        const details = describeChange(change, timezone);
        for (const detailLine of details.slice(0, diffLimit)) lines.push(`  - ${detailLine}`);
        if (details.length > diffLimit) lines.push(`  - … ${details.length - diffLimit} more changed lines`);
      }
      lines.push("");
    }
    if (course.coverage.warnings.length) {
      lines.push("### Warnings", "");
      for (const warning of course.coverage.warnings) {
        const [first = "No details provided.", ...rest] = String(warning.message)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("Suggestion:"));
        lines.push(`- **${warning.kind}${warning.id ? ` ${warning.id}` : ""}**: ${first}`);
        for (const line of rest) lines.push(`  ${line}`);
      }
      lines.push("");
    }
  }
  if (quiet.length) lines.push(`No changes: ${quiet.join(", ")}`, "");
  const notes = courses.filter((course) => course.coverage.notes.length);
  if (notes.length) {
    lines.push("## Coverage notes", "");
    for (const course of notes) for (const note of course.coverage.notes) lines.push(`- ${course.code}: ${note}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
