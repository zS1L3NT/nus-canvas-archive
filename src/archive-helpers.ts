import { formatDate } from "./lib.ts";
import type {
  AssignmentDate,
  AssignmentOverride,
  CanvasAssignment,
  CanvasInboxConversation,
  CanvasWarning,
} from "./types.ts";

export function sanitizeCanvasSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitizeCanvasSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeCanvasSecrets(item)])) as T;
  }
  if (typeof value !== "string") return value;
  return value.replace(/([?&](?:verifier|access_token)=)[^&"'\s<>]+/gi, "$1<redacted>") as T;
}

export function embeddedFileIds(value: unknown): Set<number> {
  const ids = new Set<number>();
  const serialized = JSON.stringify(value) ?? "";
  for (const match of serialized.matchAll(/\/files\/(\d+)/g)) ids.add(Number(match[1]));
  return ids;
}

export function assignmentDates(
  assignment: Pick<CanvasAssignment, "due_at" | "unlock_at" | "lock_at">,
  overrides?: AssignmentOverride[],
): AssignmentDate[] {
  const dates: AssignmentDate[] = [];
  if (assignment.due_at)
    dates.push({
      audience: "Course",
      due_at: assignment.due_at,
      unlock_at: assignment.unlock_at,
      lock_at: assignment.lock_at,
    });
  for (const override of overrides ?? []) {
    dates.push({
      audience: override.title || `Override ${override.id}`,
      due_at: override.due_at,
      unlock_at: override.unlock_at,
      lock_at: override.lock_at,
      override_id: override.id,
      course_section_id: override.course_section_id || null,
      group_id: override.group_id || null,
      student_ids: override.student_ids || [],
    });
  }
  return dates;
}

export function incompleteDocumentKinds(warnings: Array<Pick<CanvasWarning, "kind">> = []): string[] {
  const warningKinds = new Set(warnings.map((warning) => warning.kind));
  const mappings: Array<[string, string[]]> = [
    ["module", ["module"]],
    ["page", ["page-list", "page"]],
    ["assignment", ["assignment-list"]],
    ["announcement", ["announcement"]],
    ["quiz", ["quiz-list"]],
    ["calendar", ["calendar"]],
    ["file", ["file-list"]],
    ["inbox", ["inbox-list", "inbox", "inbox-attribution"]],
  ];
  return mappings.filter(([, kinds]) => kinds.some((kind) => warningKinds.has(kind))).map(([kind]) => kind);
}

export function inboxListArgs(courseId: number): string[] {
  return ["api", "GET", "/api/v1/conversations", "--paginate", "--query", `filter[]=course_${courseId}`];
}

export function inboxDetailArgs(conversationId: number): string[] {
  return ["api", "GET", `/api/v1/conversations/${conversationId}`, "--query", "auto_mark_as_read=false"];
}

export function inboxConversationOrder(
  left: { id: number; last_message_at?: string; updated_at?: string },
  right: { id: number; last_message_at?: string; updated_at?: string },
): number {
  return (
    new Date(String(left.last_message_at || left.updated_at || 0)).getTime() -
      new Date(String(right.last_message_at || right.updated_at || 0)).getTime() || Number(left.id) - Number(right.id)
  );
}

export function conversationBelongsToCourse(conversation: unknown, courseId: number): boolean {
  if (!conversation || typeof conversation !== "object") return true;
  const record = conversation as Record<string, unknown>;
  const explicit: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") explicit.push(String(value));
    else if (Array.isArray(value)) value.forEach(add);
  };
  add(record.context_code);
  add(record.context_codes);
  add(record.course_id);
  add(record.course_ids);
  if (record.audience_contexts && typeof record.audience_contexts === "object") {
    for (const [key, value] of Object.entries(record.audience_contexts)) {
      if (key === "courses" && value && typeof value === "object") explicit.push(...Object.keys(value));
      else if (/^(?:course_)?\d+$/.test(key)) explicit.push(key);
    }
  }
  if (record.context && typeof record.context === "object") {
    const context = record.context as Record<string, unknown>;
    add(context.context_code);
    add(context.course_id);
    if (String(context.type || "").toLowerCase() === "course") add(context.id);
  }
  if (!explicit.length) return true;
  return explicit.some((value) => value === String(courseId) || value === `course_${courseId}`);
}

export function forwardedMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  const messages = Array.isArray(value) ? [...value].reverse() : value && typeof value === "object" ? [value] : [];
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const record = message as Record<string, unknown>;
      const body = String(record.body || record.html_body || "");
      const attachments = Array.isArray(record.attachments) ? record.attachments : [];
      const attachmentLines = attachments
        .map((attachment) => {
          if (!attachment || typeof attachment !== "object") return "";
          const item = attachment as Record<string, unknown>;
          const label = String(item.display_name || item.filename || item.name || "Attachment");
          const url = String(item.url || item.href || "");
          const details = [item["content-type"], item.size].filter(Boolean).map(String).join(", ");
          return `- ${url ? `[${label}](${url})` : label}${details ? ` (${details})` : ""}`;
        })
        .filter(Boolean);
      const media = record.media_comment || record.media_comment_url;
      const mediaLine =
        typeof media === "string"
          ? `- Media: [Open media](${media})`
          : media && typeof media === "object"
            ? (() => {
                const item = media as Record<string, unknown>;
                const label = String(item.display_name || item.name || item.media_id || "Media");
                const url = String(item.url || item.href || item.media_comment_url || "");
                return `- Media: ${url ? `[${label}](${url})` : label}`;
              })()
            : "";
      const nested = forwardedMessageContent(record.forwarded_messages || record.forwarded_message);
      return [
        body,
        attachmentLines.length ? `#### Attachments\n\n${attachmentLines.join("\n")}` : "",
        mediaLine,
        nested ? `#### Nested forwarded message\n\n${nested}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function inboxMarkdown(conversation: CanvasInboxConversation, markdown: (html: string) => string): string {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
  const authorName = (message: (typeof messages)[number], index: number): string => {
    const participant = participants.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        String((candidate as Record<string, unknown>).id) === String(message.author_id),
    ) as Record<string, unknown> | undefined;
    const author =
      message.author?.display_name ||
      message.author?.name ||
      message.author?.sortable_name ||
      participant?.display_name ||
      participant?.name ||
      participant?.full_name ||
      (message.author_id ? `User ${message.author_id}` : `Message ${index + 1}`);
    return String(author);
  };
  const messageLines = [...messages].reverse().map((message, index) => {
    const timestamp = message.created_at ? ` — ${formatDate(message.created_at)}` : "";
    return `### ${authorName(message, index)}${timestamp}\n\n${markdown(forwardedMessageContent(message))}`;
  });
  return messageLines.length ? messageLines.join("\n\n") : markdown(conversation.last_message || "");
}
