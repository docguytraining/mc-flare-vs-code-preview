import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "../core/types";
import { logInfo, logWarning } from "../core/logger";

const SIDECAR_RELATIVE_PATH = path.join(".vscode", "flare-preview.json");

interface DismissalFile {
  topicDismissals: Record<string, string[]>;
  previewTarget?: string;
}

/**
 * Read/write store for per-topic variable suggestion dismissals.
 *
 * The store lives at `<projectRoot>/.vscode/flare-preview.json` so each Flare
 * project keeps its own list and the file can be source-controlled alongside
 * the rest of the project. Topic paths are stored relative to the project
 * root in POSIX form so the file is portable across operating systems.
 *
 * Schema (intentionally a wrapper so we can add other per-project preview
 * settings later without changing the file's identity):
 *
 *   {
 *     "topicDismissals": {
 *       "Content/Identity/c-identity-connectors-about.htm": [
 *         "UI.user"
 *       ]
 *     }
 *   }
 *
 * Reads are synchronous-ish and uncached: the file is small, refreshes are
 * cheap, and avoiding a cache means file watcher invalidation isn't required.
 */
export class DismissalStore {
  /** Returns the variable names dismissed for the given topic, in any order. */
  public async getDismissedVariables(
    projectContext: FlareProjectContext,
    topicUri: vscode.Uri
  ): Promise<string[]> {
    const data = await readDismissalFile(projectContext);
    const key = topicKey(projectContext, topicUri);
    return data.topicDismissals[key] ?? [];
  }

  /** Adds a variable to a topic's dismissal list and persists the sidecar. */
  public async dismissForTopic(
    projectContext: FlareProjectContext,
    topicUri: vscode.Uri,
    variableName: string
  ): Promise<void> {
    const data = await readDismissalFile(projectContext);
    const key = topicKey(projectContext, topicUri);
    const existing = data.topicDismissals[key] ?? [];
    if (existing.includes(variableName)) {
      return;
    }
    const next = [...existing, variableName].sort();
    data.topicDismissals[key] = next;
    await writeDismissalFile(projectContext, data);
    logInfo(`Dismissed '${variableName}' for ${key}.`);
  }

  /**
   * Updates the sidecar in response to an in-IDE topic rename. Renames done
   * outside VS Code can't be observed and turn the corresponding entry into
   * a stale entry instead.
   */
  public async renameTopic(
    projectContext: FlareProjectContext,
    oldTopicUri: vscode.Uri,
    newTopicUri: vscode.Uri
  ): Promise<void> {
    const data = await readDismissalFile(projectContext);
    const oldKey = topicKey(projectContext, oldTopicUri);
    const newKey = topicKey(projectContext, newTopicUri);
    if (oldKey === newKey) {
      return;
    }
    const moved = data.topicDismissals[oldKey];
    if (!moved || moved.length === 0) {
      return;
    }
    delete data.topicDismissals[oldKey];
    // If the destination already had its own dismissals, merge with the
    // moved list (deduped, sorted) so we never silently lose anything.
    const existingAtDest = data.topicDismissals[newKey] ?? [];
    data.topicDismissals[newKey] = Array.from(new Set([...existingAtDest, ...moved])).sort();
    await writeDismissalFile(projectContext, data);
    logInfo(`Migrated dismissals from ${oldKey} to ${newKey}.`);
  }

  /** Returns the persisted preview target id for the project (if any). */
  public async getPreviewTarget(
    projectContext: FlareProjectContext
  ): Promise<string | undefined> {
    const data = await readDismissalFile(projectContext);
    return data.previewTarget;
  }

  /** Persists the chosen preview target id for the project. */
  public async setPreviewTarget(
    projectContext: FlareProjectContext,
    targetId: string | undefined
  ): Promise<void> {
    const data = await readDismissalFile(projectContext);
    if (targetId === undefined) {
      delete data.previewTarget;
    } else {
      data.previewTarget = targetId;
    }
    await writeDismissalFile(projectContext, data);
  }

  /**
   * Logs a warning to the output channel for every entry whose topic file no
   * longer exists on disk. Returns the list of stale keys so callers (a
   * future "Prune Dismissals" command) can act on them.
   */
  public async detectStaleEntries(projectContext: FlareProjectContext): Promise<string[]> {
    const data = await readDismissalFile(projectContext);
    const stale: string[] = [];
    for (const relPath of Object.keys(data.topicDismissals)) {
      const absPath = path.join(projectContext.projectRoot.fsPath, relPath);
      if (!existsSync(absPath)) {
        stale.push(relPath);
      }
    }
    if (stale.length > 0) {
      logWarning(
        `Stale dismissal entries (topic no longer exists): ${stale.join(", ")}`
      );
    }
    return stale;
  }
}

function topicKey(projectContext: FlareProjectContext, topicUri: vscode.Uri): string {
  const relative = path.relative(projectContext.projectRoot.fsPath, topicUri.fsPath);
  return relative.replace(/\\/g, "/");
}

function sidecarPath(projectContext: FlareProjectContext): string {
  return path.join(projectContext.projectRoot.fsPath, SIDECAR_RELATIVE_PATH);
}

async function readDismissalFile(projectContext: FlareProjectContext): Promise<DismissalFile> {
  const filePath = sidecarPath(projectContext);
  try {
    const bytes = await fs.readFile(filePath);
    const text = stripBom(Buffer.from(bytes).toString("utf8"));
    const parsed = JSON.parse(text) as Partial<DismissalFile>;
    if (!parsed || typeof parsed !== "object" || parsed.topicDismissals === undefined) {
      return { topicDismissals: {} };
    }
    if (typeof parsed.topicDismissals !== "object" || parsed.topicDismissals === null) {
      return { topicDismissals: {} };
    }
    // Defensive: ensure every value is a string array.
    const cleaned: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed.topicDismissals)) {
      if (Array.isArray(value)) {
        cleaned[key] = value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }
    }
    const result: DismissalFile = { topicDismissals: cleaned };
    if (typeof parsed.previewTarget === "string" && parsed.previewTarget.length > 0) {
      result.previewTarget = parsed.previewTarget;
    }
    return result;
  } catch (error) {
    if (isFileNotFound(error)) {
      return { topicDismissals: {} };
    }
    logWarning(`Failed to read ${filePath}: ${String(error)}`);
    return { topicDismissals: {} };
  }
}

async function writeDismissalFile(
  projectContext: FlareProjectContext,
  data: DismissalFile
): Promise<void> {
  const filePath = sidecarPath(projectContext);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Sort topic keys for deterministic diffs.
  const sortedKeys = Object.keys(data.topicDismissals).sort();
  const sortedData: DismissalFile = { topicDismissals: {} };
  for (const key of sortedKeys) {
    const list = data.topicDismissals[key];
    if (list && list.length > 0) {
      sortedData.topicDismissals[key] = [...list].sort();
    }
  }
  if (data.previewTarget) {
    sortedData.previewTarget = data.previewTarget;
  }

  const json = `${JSON.stringify(sortedData, null, 2)}\n`;
  await fs.writeFile(filePath, json, "utf8");
}

function isFileNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  return false;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
