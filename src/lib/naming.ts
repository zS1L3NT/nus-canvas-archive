import path from "node:path";
import { decodeHtml } from "./text.ts";

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
}

export function safeName(value: unknown, fallback = "untitled"): string {
  const normalized = stripControlCharacters(decodeHtml(String(value ?? "")).normalize("NFKC"))
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return (normalized || fallback).slice(0, 180);
}

// Obsidian treats #, ^, [ and ] as link syntax, so vault names avoid them.
export function vaultName(value: unknown, fallback = "untitled"): string {
  return safeName(value, fallback)
    .replace(/#(?=\d)/g, "")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/[#^]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// The lowest ID keeps the plain name, so adding a duplicate never renames an existing note.
export function uniqueNames<T>(
  items: T[],
  nameForItem: (item: T) => string,
  idForItem: (item: T) => number,
): Map<T, string> {
  const names = new Map<T, string>();
  const taken = new Map<string, number>();
  for (const item of [...items].sort((left, right) => idForItem(left) - idForItem(right))) {
    const name = nameForItem(item);
    const key = name.toLocaleLowerCase("en");
    const count = (taken.get(key) || 0) + 1;
    taken.set(key, count);
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    names.set(item, count > 1 ? `${stem} (${count})${extension}` : name);
  }
  return names;
}

export function byPosition<T extends { position?: number | string | null }>(items: T[] = []): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPosition = Number(left.item.position ?? Number.NaN);
      const rightPosition = Number(right.item.position ?? Number.NaN);
      const positionDifference =
        (Number.isFinite(leftPosition) ? leftPosition : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(rightPosition) ? rightPosition : Number.MAX_SAFE_INTEGER);
      return positionDifference || left.index - right.index;
    })
    .map(({ item }) => item);
}
