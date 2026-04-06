import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "../core/types";

export interface Bookmark {
  id: string;
  element: string;
  displayText?: string;
}

export interface TopicIndexEntry {
  absPath: string;
  relPath: string;
  uri: vscode.Uri;
  h1: string | undefined;
  bookmarks: Bookmark[];
}

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

const TOPIC_EXTENSIONS = new Set([".htm", ".html"]);

const H1_REGEX = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const ID_ATTR_REGEX = /<([A-Za-z][A-Za-z0-9]*)\b([^>]*?)\bid\s*=\s*["']([^"']+)["']([^>]*)>/gi;
const ANCHOR_NAME_REGEX = /<a\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/gi;
const MADCAP_ANCHOR_REGEX = /<MadCap:anchor\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
const TAG_STRIP_REGEX = /<[^>]+>/g;

/**
 * Project-wide index of `.htm`/`.html` topics under a Flare project root.
 *
 * Entries record the topic's first `<h1>` text (for search display) and every
 * discoverable bookmark (`id=` attributes, `<a name="…">`, `<MadCap:anchor>`).
 * Per-project results are cached and invalidated whenever a topic file changes
 * on disk.
 */
export class TopicIndex {
  private readonly cache = new Map<string, Promise<TopicIndexEntry[]>>();

  public async getEntries(projectContext: FlareProjectContext): Promise<TopicIndexEntry[]> {
    const projectRoot = projectContext.projectRoot.fsPath;
    const cached = this.cache.get(projectRoot);
    if (cached) {
      return cached;
    }

    const loading = this.scanProject(projectRoot);
    this.cache.set(projectRoot, loading);
    try {
      return await loading;
    } catch (error) {
      this.cache.delete(projectRoot);
      throw error;
    }
  }

  public async getBookmarks(uri: vscode.Uri): Promise<Bookmark[]> {
    const text = await readTextOrUndefined(uri.fsPath);
    if (text === undefined) {
      return [];
    }
    return extractBookmarks(text);
  }

  public invalidateForPath(fsPath: string): void {
    const normalized = path.normalize(fsPath);
    for (const projectRoot of [...this.cache.keys()]) {
      if (normalized.startsWith(projectRoot)) {
        this.cache.delete(projectRoot);
      }
    }
  }

  public invalidateAll(): void {
    this.cache.clear();
  }

  private async scanProject(projectRoot: string): Promise<TopicIndexEntry[]> {
    const files: string[] = [];
    await walkDirectory(projectRoot, files);

    const entries: TopicIndexEntry[] = [];
    for (const absPath of files) {
      const text = await readTextOrUndefined(absPath);
      if (text === undefined) {
        continue;
      }
      entries.push({
        absPath,
        relPath: path.relative(projectRoot, absPath).replace(/\\/g, "/"),
        uri: vscode.Uri.file(absPath),
        h1: extractH1(text),
        bookmarks: extractBookmarks(text)
      });
    }

    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return entries;
  }
}

async function walkDirectory(dirPath: string, accumulator: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await walkDirectory(path.join(dirPath, entry.name), accumulator);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (TOPIC_EXTENSIONS.has(extension)) {
      accumulator.push(path.join(dirPath, entry.name));
    }
  }
}

export function extractH1(html: string): string | undefined {
  const match = H1_REGEX.exec(html);
  if (!match?.[1]) {
    return undefined;
  }
  const text = match[1].replace(TAG_STRIP_REGEX, "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

export function extractBookmarks(html: string): Bookmark[] {
  const seen = new Set<string>();
  const bookmarks: Bookmark[] = [];

  const pushBookmark = (bookmark: Bookmark): void => {
    if (seen.has(bookmark.id)) {
      return;
    }
    seen.add(bookmark.id);
    bookmarks.push(bookmark);
  };

  ID_ATTR_REGEX.lastIndex = 0;
  let idMatch = ID_ATTR_REGEX.exec(html);
  while (idMatch) {
    const element = idMatch[1];
    const id = idMatch[3];
    if (id && element && element.toLowerCase() !== "meta") {
      pushBookmark({ id, element: element.toLowerCase() });
    }
    idMatch = ID_ATTR_REGEX.exec(html);
  }

  ANCHOR_NAME_REGEX.lastIndex = 0;
  let nameMatch = ANCHOR_NAME_REGEX.exec(html);
  while (nameMatch) {
    if (nameMatch[1]) {
      pushBookmark({ id: nameMatch[1], element: "a" });
    }
    nameMatch = ANCHOR_NAME_REGEX.exec(html);
  }

  MADCAP_ANCHOR_REGEX.lastIndex = 0;
  let madcapMatch = MADCAP_ANCHOR_REGEX.exec(html);
  while (madcapMatch) {
    if (madcapMatch[1]) {
      pushBookmark({ id: madcapMatch[1], element: "MadCap:anchor" });
    }
    madcapMatch = MADCAP_ANCHOR_REGEX.exec(html);
  }

  return bookmarks;
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}
