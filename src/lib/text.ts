import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import english from "@tesseract.js-data/eng";
import { strFromU8, unzipSync } from "fflate";
import parseRtf from "rtf-parser";
import { createWorker } from "tesseract.js";
import { extractText as pdfText } from "unpdf";
import WordExtractor from "word-extractor";
import type { TextExtraction } from "../types.ts";
import { atomicWrite, sha256 } from "./serialization.ts";

const entityMap: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
};

const plainTextExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".markdown",
  ".md",
  ".mjs",
  ".py",
  ".sql",
  ".ts",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const zipTextExtensions = new Set([
  ".csv",
  ".java",
  ".js",
  ".json",
  ".md",
  ".py",
  ".sql",
  ".ts",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function decodeHtml(value: unknown = ""): string {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entityMap[entity.toLowerCase()] ?? match;
  });
}

type ImageSource = (fileId: number | null, source: string) => string;
type LinkTarget = (href: string) => string | null;

export function markdownDestination(target: string): string {
  return target
    .replaceAll("%", "%25")
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll(">", "%3E")
    .replaceAll("#", "%23")
    .replaceAll("^", "%5E");
}

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return decodeHtml(match?.[2] ?? "").trim();
}

function imageMarkdown(tag: string, imageSource?: ImageSource): string {
  const source = htmlAttribute(tag, "src");
  const endpoint = htmlAttribute(tag, "data-api-endpoint");
  const fileId = endpoint.match(/\/files\/(\d+)/)?.[1] ?? source.match(/\/files\/(\d+)/)?.[1];
  const resolved = imageSource?.(fileId ? Number(fileId) : null, source) || source;
  if (!resolved) return htmlAttribute(tag, "alt");
  const cleanSource = resolved.replace(/([?&](?:verifier|access_token)=)(?:<redacted>|%3Credacted%3E)(&|$)/gi, "$2");
  const alt = htmlAttribute(tag, "alt").replaceAll("]", "\\]");
  const destination = cleanSource
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll(">", "%3E");
  return `![${alt}](${destination})`;
}

export function htmlToMarkdown(html: unknown = "", imageSource?: ImageSource, linkTarget?: LinkTarget): string {
  let text = String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => imageMarkdown(tag, imageSource))
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const cleanLabel = decodeHtml(label.replace(/<[^>]+>/g, "")).trim() || href;
      const target = linkTarget?.(decodeHtml(href));
      return `[${cleanLabel}](${target ? markdownDestination(target) : href})`;
    })
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level, body) => `\n${"#".repeat(Number(level))} ${body}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeHtml(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? `${text}\n` : "";
}

function xmlText(xml: string, tagPattern: RegExp): string {
  const values = [];
  for (const match of xml.matchAll(tagPattern)) {
    if (match[1]) values.push(decodeHtml(match[1].replace(/<[^>]+>/g, "")));
  }
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function archive(data: Uint8Array, select: (entry: string) => boolean): Record<string, Uint8Array> {
  let size = 0;
  return unzipSync(data, {
    filter(entry) {
      if (!select(entry.name)) return false;
      size += entry.originalSize;
      if (size > 200 * 1024 * 1024) throw new Error("Selected archive content exceeds 200 MiB");
      return true;
    },
  });
}

function officeXmlText(data: Uint8Array, extension: string): string {
  const files = archive(data, (entry) =>
    extension === ".pptx"
      ? /^ppt\/(slides|notesSlides)\/.*\.xml$/.test(entry)
      : /^xl\/(sharedStrings\.xml|worksheets\/.*\.xml)$/.test(entry),
  );
  const xml = Object.entries(files)
    .sort(([left], [right]) => naturalCompare(left, right))
    .map(([, data]) => strFromU8(data))
    .join("");
  return xmlText(
    xml,
    extension === ".pptx" ? /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g : /<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/g,
  );
}

function zipText(data: Uint8Array): string {
  const entries: string[] = [];
  const files = archive(data, (entry) => {
    if (entry.endsWith("/") || entry.startsWith("/") || entry.split("/").includes("..")) return false;
    entries.push(entry);
    const extension = path.extname(entry).toLowerCase();
    return zipTextExtensions.has(extension) || extension === ".xlsx" || extension === ".pptx";
  });
  entries.sort(naturalCompare);
  const sections = [`Archive contents:\n${entries.join("\n")}`];
  for (const entry of entries) {
    const data = files[entry];
    if (!data) continue;
    const extension = path.extname(entry).toLowerCase();
    if (zipTextExtensions.has(extension)) sections.push(`## ${entry}\n\n${strFromU8(data).trim()}`);
    else {
      const text = officeXmlText(data, extension);
      if (text) sections.push(`## ${entry}\n\n${text}`);
    }
  }
  return sections.join("\n\n");
}

function rtfText(node: import("rtf-parser").RtfNode): string {
  return node.value ?? node.content?.map((child) => rtfText(child) + (child.content ? "\n" : "")).join("") ?? "";
}

export async function extractText(
  filePath: string,
  destination: string,
  {
    contentType = "",
    maxSourceBytes = 100 * 1024 * 1024,
    mtime,
  }: { contentType?: string; maxSourceBytes?: number; mtime?: string | number | Date } = {},
): Promise<TextExtraction> {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxSourceBytes) return { status: "skipped-too-large", bytes: 0 };
  const extension = path.extname(filePath).toLowerCase();
  let text = "";
  try {
    if (plainTextExtensions.has(extension) || contentType.startsWith("text/")) {
      text = await readFile(filePath, "utf8");
      if (extension === ".html" || extension === ".htm" || contentType.includes("html")) text = htmlToMarkdown(text);
    } else if (extension === ".html" || extension === ".htm") {
      text = htmlToMarkdown(await readFile(filePath, "utf8"));
    } else if (extension === ".pdf" || contentType === "application/pdf") {
      text = (await pdfText(new Uint8Array(await readFile(filePath)), { mergePages: true })).text;
    } else if (extension === ".doc" || extension === ".docx") {
      const document = await new WordExtractor().extract(await readFile(filePath));
      const options = { filterUnicode: false };
      text = [
        document.getBody(options),
        document.getHeaders(options),
        document.getFootnotes(options),
        document.getEndnotes(options),
        document.getTextboxes(options),
      ]
        .filter((value) => value.trim())
        .join("\n");
    } else if (extension === ".rtf") {
      text = rtfText(await promisify(parseRtf.string)(await readFile(filePath, "latin1")));
    } else if (extension === ".odt") {
      const files = archive(await readFile(filePath), (entry) => entry === "content.xml");
      text = xmlText(
        strFromU8(files["content.xml"] ?? new Uint8Array()),
        /<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g,
      );
    } else if (extension === ".pptx" || extension === ".xlsx") {
      text = officeXmlText(await readFile(filePath), extension);
    } else if (extension === ".zip" || contentType.includes("zip")) {
      text = zipText(await readFile(filePath));
    } else if ([".jpg", ".jpeg", ".png", ".tif", ".tiff"].includes(extension) || contentType.startsWith("image/")) {
      const worker = await createWorker("eng", 1, { langPath: english.langPath, gzip: true, cacheMethod: "none" });
      try {
        text = (await worker.recognize(filePath)).data.text;
      } finally {
        await worker.terminate();
      }
    } else {
      return { status: "unsupported", bytes: 0 };
    }
  } catch (error) {
    return { status: "failed", bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const normalized = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!normalized) return { status: "empty", bytes: 0 };
  await atomicWrite(destination, `${normalized}\n`, mtime);
  return { status: "extracted", bytes: Buffer.byteLength(normalized), sha256: sha256(normalized) };
}
