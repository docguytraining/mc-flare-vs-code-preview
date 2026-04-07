import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "../core/types";

export interface SnippetIndexEntry {
  /** Absolute filesystem path to the `.flsnp` file. */
  absPath: string;
  /** Path relative to the project root, forward-slashed. */
  relPath: string;
  /** `vscode.Uri` for the same file (for editor commands). */
  uri: vscode.Uri;
  /** Display name (filename without `.flsnp`). */
  name: string;
  /** Subfolder under `Content/Resources/Snippets`, forward-slashed; "" for top-level. */
  folder: string;
  /** First non-empty text content from the snippet body, truncated for display. */
  preview: string | undefined;
}

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

const SNIPPET_EXTENSION = ".flsnp";
const SNIPPETS_ROOT = path.join("Content", "Resources", "Snippets");
const TAG_STRIP_REGEX = /<[^>]+>/g;
const PREVIEW_MAX_LENGTH = 80;

/**
 * Project-wide index of `.flsnp` snippet files. Mirrors {@link TopicIndex}:
 * caches per project root and invalidates when any `.flsnp` file changes on
 * disk. Used by the snippet picker, the `{{` bracket completion provider,
 * and the `<MadCap:snippet src="…">` attribute completion provider.
 *
 * The walker prefers the conventional `Content/Resources/Snippets` directory
 * but also picks up `.flsnp` files anywhere else under the project root, so
 * non-standard layouts still work.
 */
export class SnippetIndex {
  private readonly cache = new Map<string, Promise<SnippetIndexEntry[]>>();

  public async getEntries(projectContext: FlareProjectContext): Promise<SnippetIndexEntry[]> {
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

  private async scanProject(projectRoot: string): Promise<SnippetIndexEntry[]> {
    const files: string[] = [];
    await walkDirectory(projectRoot, files);
    const snippetsRoot = path.join(projectRoot, SNIPPETS_ROOT);

    const entries: SnippetIndexEntry[] = [];
    for (const absPath of files) {
      const text = await readTextOrUndefined(absPath);
      const folder = absPath.startsWith(snippetsRoot)
        ? path
            .relative(snippetsRoot, path.dirname(absPath))
            .replace(/\\/g, "/")
        : path
            .relative(path.join(projectRoot, "Content"), path.dirname(absPath))
            .replace(/\\/g, "/");
      entries.push({
        absPath,
        relPath: path.relative(projectRoot, absPath).replace(/\\/g, "/"),
        uri: vscode.Uri.file(absPath),
        name: path.basename(absPath, SNIPPET_EXTENSION),
        folder,
        preview: text === undefined ? undefined : extractSnippetPreview(text)
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
    if (path.extname(entry.name).toLowerCase() === SNIPPET_EXTENSION) {
      accumulator.push(path.join(dirPath, entry.name));
    }
  }
}

/**
 * Extracts a one-line preview from a `.flsnp` body. Strips XML/HTML markup
 * and collapses whitespace. Returns `undefined` when the snippet is empty.
 */
export function extractSnippetPreview(xml: string): string | undefined {
  const bodyMatch = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const inner = bodyMatch ? bodyMatch[1] : xml;
  const text = inner
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(TAG_STRIP_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : text;
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}
