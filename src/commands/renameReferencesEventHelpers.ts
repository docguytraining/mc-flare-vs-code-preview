import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { FileRename } from "./renameReferencesHelpers";

/**
 * Filesystem-only helpers for the rename references event handler. Kept
 * free of `vscode` imports so they can be exercised by node-only unit
 * tests, in the same spirit as `extractSnippetHelpers.ts`.
 *
 * Two pieces live here:
 *
 *  1. {@link expandIfDirectoryRename} — when VS Code's `onDidRenameFiles`
 *     event hands us a directory URI (folder rename), walk the new
 *     directory and emit one `FileRename` per contained file. Without
 *     this expansion, the cross-project rename scanner skips folder
 *     renames entirely because folders don't carry a recognized
 *     `RENAME_TRIGGER_EXTENSIONS` extension.
 *
 *  2. {@link pruneExpired} — drops expired entries from the
 *     drag-and-drop pairing cache the create/delete fallback maintains.
 *     Pure, but worth covering directly so the cache can't grow without
 *     bound during a long editing session.
 */

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

export async function expandIfDirectoryRename(
  oldDir: string,
  newDir: string
): Promise<FileRename[]> {
  let stat;
  try {
    stat = await fs.stat(newDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const accumulator: FileRename[] = [];
  await collectDirectoryRenames(oldDir, newDir, accumulator);
  return accumulator;
}

async function collectDirectoryRenames(
  oldDir: string,
  newDir: string,
  accumulator: FileRename[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(newDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("._")) {
      continue;
    }
    const oldEntryPath = path.join(oldDir, entry.name);
    const newEntryPath = path.join(newDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectDirectoryRenames(oldEntryPath, newEntryPath, accumulator);
      continue;
    }
    if (entry.isFile()) {
      accumulator.push({ oldPath: oldEntryPath, newPath: newEntryPath });
    }
  }
}

export function pruneExpired(
  store: Map<string, { fsPath: string; expiresAt: number }[]>
): void {
  const now = Date.now();
  for (const [key, list] of store) {
    const filtered = list.filter((entry) => entry.expiresAt > now);
    if (filtered.length === 0) {
      store.delete(key);
    } else if (filtered.length !== list.length) {
      store.set(key, filtered);
    }
  }
}
