import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { FlareProjectContext } from "../core/types";
import { ConditionTagIndex } from "../flare/conditionTagIndex";
import { logError, logInfo } from "../core/logger";

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

const SCANNABLE_EXTENSIONS = new Set([".htm", ".html"]);
const FLARE_EXTENSION_REGEX = /^\.fl[a-z0-9]+$/i;

interface ConditionTagOccurrence {
  filePath: string;
  start: number;
  length: number;
  before: string;
  after: string;
  context: string;
  line: number;
  column: number;
}

interface QuickPickOccurrenceItem extends vscode.QuickPickItem {
  occurrence: ConditionTagOccurrence;
}

/**
 * Registers the `flare.renameConditionTag` command. Renames a condition tag
 * across every Flare-readable file in the project: source `.flcts` definition
 * (the `<ConditionTag Name="…" />` element), every topic's `MadCap:conditions=`
 * and `MadCap:conditionTagExpression=` attributes, every target's
 * `ConditionExpression="…"` attribute, and the project file's
 * `PreviewConditionalExpression="…"`.
 *
 * This is a "rename within a set" operation — the set name (the part before
 * the dot) cannot change because Flare derives that from the `.flcts`
 * filename. Moving a tag between sets requires editing the .flcts files
 * directly and is intentionally out of scope.
 *
 * Workflow mirrors `flare.renameReferences`:
 *
 *   1. Pick a tag from the project (defaults to the token under the cursor).
 *   2. Enter the new tag name (just the part after the dot).
 *   3. Scan every scannable file in the project for occurrences of the old
 *      qualified name; collect each `before → after` rewrite.
 *   4. Show a multi-select quick pick of every occurrence with all entries
 *      pre-checked. Author can uncheck anything they want left alone.
 *   5. Apply a single `WorkspaceEdit` so the rename is one undo step.
 */
export function registerRenameConditionTagCommand(
  projectResolver: FlareProjectResolver,
  conditionTagIndex: ConditionTagIndex
): vscode.Disposable {
  return vscode.commands.registerCommand("flare.renameConditionTag", async () => {
    try {
      await runRenameConditionTagCommand(projectResolver, conditionTagIndex);
    } catch (error) {
      logError("Rename condition tag failed", error);
      vscode.window.showErrorMessage(
        `Flare: Rename Condition Tag failed (${String(error)})`
      );
    }
  });
}

async function runRenameConditionTagCommand(
  projectResolver: FlareProjectResolver,
  conditionTagIndex: ConditionTagIndex
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let projectContext: FlareProjectContext | undefined;
  if (editor) {
    projectContext = await projectResolver
      .resolveForFile(editor.document.uri)
      .catch(() => undefined);
  }
  if (!projectContext) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const probe = await projectResolver
        .resolveForFile(vscode.Uri.joinPath(folder.uri, "placeholder.htm"))
        .catch(() => undefined);
      if (probe) {
        projectContext = probe;
        break;
      }
    }
  }
  if (!projectContext) {
    vscode.window.showWarningMessage(
      "Flare: cannot rename condition tag — no .flprj project was found in the workspace."
    );
    return;
  }

  const tags = await conditionTagIndex.getEntries(projectContext);
  if (tags.length === 0) {
    vscode.window.showInformationMessage(
      "Flare: this project has no condition tags. Add a .flcts file under Project/ConditionTagSets first."
    );
    return;
  }

  const cursorTag = editor ? readQualifiedTagAtCursor(editor) : undefined;
  const items = tags.map((tag) => ({
    label: tag.qualifiedName,
    description: tag.color ? `color ${tag.color}` : undefined,
    detail: tag.description ?? undefined,
    qualifiedName: tag.qualifiedName
  }));
  const preselect = cursorTag
    ? items.find((entry) => entry.qualifiedName === cursorTag)
    : undefined;
  // Quick pick doesn't support a default item natively, but moving the
  // preselected entry to the top of the list keeps it one keypress away.
  const orderedItems = preselect
    ? [preselect, ...items.filter((entry) => entry !== preselect)]
    : items;

  const picked = await vscode.window.showQuickPick(orderedItems, {
    title: "Rename Condition Tag",
    placeHolder: "Pick the condition tag to rename"
  });
  if (!picked) {
    return;
  }

  const oldQualified = picked.qualifiedName;
  const [setName, oldTagName] = splitQualifiedName(oldQualified);
  if (!setName || !oldTagName) {
    vscode.window.showWarningMessage(
      `Flare: cannot parse '${oldQualified}' into a Set.Tag form.`
    );
    return;
  }

  const newTagName = await vscode.window.showInputBox({
    title: `Rename ${oldQualified}`,
    prompt: `New tag name within the '${setName}' set (the part before the dot can't change).`,
    value: oldTagName,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "Tag name is required.";
      }
      if (!/^[A-Za-z_][\w-]*$/.test(trimmed)) {
        return "Tag name must start with a letter or underscore and contain only word characters or hyphens.";
      }
      if (trimmed === oldTagName) {
        return "New name is the same as the old name.";
      }
      return undefined;
    }
  });
  if (!newTagName) {
    return;
  }

  const newQualified = `${setName}.${newTagName.trim()}`;

  if (tags.some((tag) => tag.qualifiedName === newQualified)) {
    const confirm = await vscode.window.showWarningMessage(
      `Flare: '${newQualified}' already exists. Continuing will merge any references to '${oldQualified}' into the existing tag.`,
      { modal: true },
      "Continue"
    );
    if (confirm !== "Continue") {
      return;
    }
  }

  const occurrences = await scanProjectForOccurrences(
    projectContext.projectRoot.fsPath,
    setName,
    oldTagName,
    newTagName.trim()
  );

  if (occurrences.length === 0) {
    vscode.window.showInformationMessage(
      `Flare: no occurrences of '${oldQualified}' were found in this project.`
    );
    return;
  }

  const items2: QuickPickOccurrenceItem[] = occurrences.map((occurrence) => ({
    label: `$(file) ${path.basename(occurrence.filePath)}`,
    description: `${occurrence.line + 1}:${occurrence.column + 1}`,
    detail: `${occurrence.before}  →  ${occurrence.after}`,
    picked: true,
    occurrence
  }));

  const picks = await vscode.window.showQuickPick(items2, {
    title: `Flare: Rename Condition Tag (${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"})`,
    placeHolder:
      "Uncheck any occurrence you don't want updated, then press Enter to apply.",
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picks || picks.length === 0) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const byFile = new Map<string, ConditionTagOccurrence[]>();
  for (const pick of picks) {
    const list = byFile.get(pick.occurrence.filePath) ?? [];
    list.push(pick.occurrence);
    byFile.set(pick.occurrence.filePath, list);
  }

  for (const [file, fileOccurrences] of byFile.entries()) {
    const document = await vscode.workspace.openTextDocument(file);
    for (const occurrence of fileOccurrences) {
      const range = new vscode.Range(
        document.positionAt(occurrence.start),
        document.positionAt(occurrence.start + occurrence.length)
      );
      edit.replace(document.uri, range, occurrence.after);
    }
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    logInfo(
      `Renamed condition tag ${oldQualified} → ${newQualified} (${picks.length} occurrence(s) across ${byFile.size} file(s)).`
    );
    vscode.window.showInformationMessage(
      `Flare: renamed ${oldQualified} → ${newQualified} (${picks.length} occurrence(s) across ${byFile.size} file(s)).`
    );
    conditionTagIndex.invalidateAll();
  } else {
    vscode.window.showWarningMessage(
      "Flare: failed to apply rename edits. See the output channel."
    );
  }
}

/**
 * Searches the project for everywhere the old qualified condition tag name
 * appears. Each scannable file gets multiple targeted regexes:
 *
 *   - `<ConditionTag Name="OldTag" .../>` inside the source `.flcts` whose
 *     basename matches the set. Other `.flcts` files are skipped because the
 *     same `Name="..."` token in a different set has nothing to do with this
 *     rename.
 *   - The qualified name `Set.OldTag` as a whole-word token, used everywhere
 *     else (HTML attributes, `.fltar`, `.flprj`, TOCs, alias files…). Whole-
 *     word matching prevents `Default.Beta` from matching `Default.BetaTesting`.
 */
export async function scanProjectForOccurrences(
  projectRoot: string,
  setName: string,
  oldTagName: string,
  newTagName: string
): Promise<ConditionTagOccurrence[]> {
  const files: string[] = [];
  await collectScanFiles(projectRoot, files);

  const oldQualified = `${setName}.${oldTagName}`;
  const newQualified = `${setName}.${newTagName}`;
  const qualifiedRegex = new RegExp(
    `(?<![\\w.])${escapeRegex(oldQualified)}(?![\\w.-])`,
    "g"
  );
  const flctsNameRegex = new RegExp(
    `(<ConditionTag\\b[^>]*\\bName\\s*=\\s*["'])${escapeRegex(oldTagName)}(["'])`,
    "gi"
  );

  const occurrences: ConditionTagOccurrence[] = [];

  for (const file of files) {
    const text = await readTextOrUndefined(file);
    if (text === undefined) {
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === ".flcts") {
      // Only rewrite the Name="…" attribute in the file whose basename matches
      // the set we're renaming inside.
      if (path.basename(file, ext) === setName) {
        flctsNameRegex.lastIndex = 0;
        let match = flctsNameRegex.exec(text);
        while (match) {
          const prefix = match[1];
          const suffix = match[2];
          const before = `${prefix}${oldTagName}${suffix}`;
          const after = `${prefix}${newTagName}${suffix}`;
          const start = match.index;
          const positionInfo = positionOf(text, start);
          occurrences.push({
            filePath: file,
            start,
            length: before.length,
            before,
            after,
            context: contextAround(text, start),
            line: positionInfo.line,
            column: positionInfo.column
          });
          match = flctsNameRegex.exec(text);
        }
      }
      continue;
    }

    qualifiedRegex.lastIndex = 0;
    let match = qualifiedRegex.exec(text);
    while (match) {
      const start = match.index;
      const positionInfo = positionOf(text, start);
      occurrences.push({
        filePath: file,
        start,
        length: oldQualified.length,
        before: oldQualified,
        after: newQualified,
        context: contextAround(text, start),
        line: positionInfo.line,
        column: positionInfo.column
      });
      match = qualifiedRegex.exec(text);
    }
  }

  return occurrences;
}

function readQualifiedTagAtCursor(editor: vscode.TextEditor): string | undefined {
  const document = editor.document;
  const cursor = editor.selection.active;
  // Pull the surrounding word — VS Code's word regex by default doesn't
  // include `.`, so use a custom one that does.
  const wordRange = document.getWordRangeAtPosition(cursor, /[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*/);
  if (!wordRange) {
    return undefined;
  }
  return document.getText(wordRange);
}

function splitQualifiedName(qualified: string): [string, string] {
  const dot = qualified.indexOf(".");
  if (dot < 0) {
    return ["", qualified];
  }
  return [qualified.slice(0, dot), qualified.slice(dot + 1)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (SCANNABLE_EXTENSIONS.has(ext)) {
    return true;
  }
  return FLARE_EXTENSION_REGEX.test(ext);
}

async function collectScanFiles(rootDir: string, accumulator: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("._")) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectScanFiles(path.join(rootDir, entry.name), accumulator);
      continue;
    }
    if (entry.isFile() && isScannableFile(entry.name)) {
      accumulator.push(path.join(rootDir, entry.name));
    }
  }
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charAt(i) === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}

function contextAround(text: string, offset: number): string {
  const start = Math.max(0, offset - 30);
  const end = Math.min(text.length, offset + 30);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
