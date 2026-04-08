import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { FlareProjectContext } from "../core/types";
import { logError, logInfo } from "../core/logger";
import { applyEditAndCleanUpTabs, captureOpenTabPaths } from "./applyAndCloseHelper";
import {
  FileRename,
  isExternal,
  positionOf,
  resolveReferencePath,
  rewriteReferencePath,
  splitHash
} from "./renameReferencesHelpers";
import {
  expandIfDirectoryRename,
  pruneExpired
} from "./renameReferencesEventHelpers";

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

// File types we open and scan for references. Anything in the Flare family
// (any `.fl*` extension) plus the project's HTML topics. The intent is to
// catch references in TOCs, snippets, alias files, browse sequences, master
// pages, glossaries, relationship tables, condition tag sets, targets, and
// any future Flare project file type without having to enumerate them by
// hand. Binary assets (images, fonts) are skipped — they can't reference
// other files.
const HTML_EXTENSIONS = new Set([".htm", ".html"]);
const FLARE_EXTENSION_REGEX = /^\.fl[a-z0-9]+$/i;

// File types whose rename triggers a scan. Anything that can be referenced
// from a topic, TOC, snippet, alias file, etc. — Flare project files
// themselves, HTML topics, and the common asset types embedded via `<img>`,
// `<link>`, and CSS `url()`.
const RENAME_TRIGGER_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".mp4",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (HTML_EXTENSIONS.has(ext)) {
    return true;
  }
  return FLARE_EXTENSION_REGEX.test(ext);
}

function isRenameTriggerFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (RENAME_TRIGGER_EXTENSIONS.has(ext)) {
    return true;
  }
  return FLARE_EXTENSION_REGEX.test(ext);
}

/**
 * Generic attribute reference pattern. Captures any XML/HTML attribute whose
 * name matches a known Flare reference attribute, regardless of which tag
 * it lives on. This deliberately covers any future Flare project file type
 * without enumerating every container element.
 *
 * Known reference attributes:
 *   - `href`              — `<a>`, `<link>`, `<MadCap:xref>`, alias entries
 *   - `src` / `source`    — `<img>`, `<video>`, `<source>`, snippets
 *   - `Link`              — TOC entries, browse-sequence entries
 *   - `xlink:href`        — embedded SVG references
 *   - `File`              — alias and target files reference topics this way
 *   - `Topic`             — relationship tables and a few alias variants
 */
const ATTRIBUTE_REFERENCE_REGEX =
  /\b(?:href|src|source|Link|xlink:href|File|Topic)\s*=\s*(["'])([^"']*)\1/gi;

const REFERENCE_PATTERNS: RegExp[] = [ATTRIBUTE_REFERENCE_REGEX];

interface AffectedReference {
  filePath: string;
  rawHref: string;
  rewrittenHref: string;
  start: number;
  length: number;
  line: number;
  column: number;
  matchedRename: FileRename;
}

interface QuickPickReferenceItem extends vscode.QuickPickItem {
  reference: AffectedReference;
}

/**
 * Wires the cross-project rename feature: when an `.htm` / `.html` / `.flsnp`
 * file is renamed inside VS Code, scan the project for references that point
 * at the old path and offer to rewrite them.
 *
 * Three event sources are wired up because VS Code's Explorer doesn't
 * always surface the same kind of event for the same kind of operation:
 *   1. `onDidRenameFiles` — covers F2 / right-click rename and most
 *      drag-drop moves of regular files.
 *   2. Folder renames — fired by `onDidRenameFiles` with a folder URI
 *      rather than per-file. We expand them by walking the new directory
 *      so the scanner sees one rename per contained file.
 *   3. `onDidCreateFiles` + `onDidDeleteFiles` — drag-drop within the
 *      Explorer (especially when the user drags a file across panes or
 *      between sub-folders) sometimes lands as a delete-then-create pair
 *      instead of a rename event. We pair them up by basename inside a
 *      short window and feed the result through the same scanner. The
 *      `processedRenames` set acts as a deduplication guard so a real
 *      rename event isn't double-counted by the fallback.
 *
 * Also registers `flare.findStaleReferences` for the manual case where the
 * rename happened outside VS Code and the in-IDE event was missed.
 */
export function registerRenameReferencesHandler(
  projectResolver: FlareProjectResolver
): vscode.Disposable {
  // Cache of recently deleted files keyed by basename. The drag-drop
  // fallback consults this when a creation event arrives so it can pair
  // a paste with a same-basename delete that happened a moment earlier.
  // Entries time out after `DRAG_DROP_PAIRING_WINDOW_MS` so a delete that
  // never gets a matching create doesn't sit in memory forever.
  const recentlyDeleted = new Map<string, { fsPath: string; expiresAt: number }[]>();
  // Tracks `oldPath|newPath` pairs the rename pipeline already processed
  // in the current event loop tick so the create+delete fallback can skip
  // them when both event sources fire for the same operation.
  const processedRenames = new Set<string>();

  const dispatchRenames = async (
    renames: FileRename[],
    tabsBeforeRename: Set<string>
  ): Promise<void> => {
    if (renames.length === 0) {
      return;
    }
    // Mark every rename as processed so the create/delete fallback (which
    // runs out of band) skips work the rename pipeline already covered.
    for (const rename of renames) {
      processedRenames.add(`${rename.oldPath}|${rename.newPath}`);
    }
    // Group renames by the project they belong to so we can scan each
    // project at most once.
    const byProject = new Map<string, { context: FlareProjectContext; renames: FileRename[] }>();
    for (const rename of renames) {
      const context = await projectResolver
        .resolveForFile(vscode.Uri.file(rename.newPath))
        .catch(() => undefined);
      if (!context) {
        continue;
      }
      const key = context.projectRoot.fsPath;
      const bucket = byProject.get(key);
      if (bucket) {
        bucket.renames.push(rename);
      } else {
        byProject.set(key, { context, renames: [rename] });
      }
    }

    for (const { context, renames: bucketRenames } of byProject.values()) {
      try {
        const affected = await scanForRenames(context.projectRoot.fsPath, bucketRenames);
        if (affected.length === 0) {
          continue;
        }
        await runRenamePicker(affected, tabsBeforeRename);
      } catch (error) {
        logError("Rename references scan failed", error);
      }
    }

    // Clear processed entries on the next tick — the create+delete
    // fallback fires synchronously after the rename event so we only
    // need to suppress one tick of duplicate work.
    setTimeout(() => {
      for (const rename of renames) {
        processedRenames.delete(`${rename.oldPath}|${rename.newPath}`);
      }
    }, DRAG_DROP_PAIRING_WINDOW_MS);
  };

  const renameDisposable = vscode.workspace.onDidRenameFiles(async (event) => {
    // Snapshot tabs at the very start of the rename event handler, before
    // any document loading happens. The helper later uses this set to
    // decide which tabs to close — without an early snapshot, any tab
    // surfaced by the rename's own openTextDocument calls would end up
    // wrongly classified as "user already had it open".
    const tabsBeforeRename = captureOpenTabPaths();

    const renames: FileRename[] = [];
    for (const { oldUri, newUri } of event.files) {
      if (oldUri.scheme !== "file" || newUri.scheme !== "file") {
        continue;
      }
      // Folders never carry a recognized "trigger" extension, so the
      // legacy single-file path skips them entirely. When the rename
      // event hands us a directory, walk the new directory and emit one
      // rename per contained file. Without this, an Explorer folder
      // rename leaves every cross-folder reference broken.
      const expanded = await expandIfDirectoryRename(oldUri.fsPath, newUri.fsPath);
      if (expanded.length > 0) {
        for (const child of expanded) {
          if (isRenameTriggerFile(child.oldPath)) {
            renames.push(child);
          }
        }
        continue;
      }
      if (isRenameTriggerFile(oldUri.fsPath)) {
        renames.push({ oldPath: oldUri.fsPath, newPath: newUri.fsPath });
      }
    }
    if (renames.length === 0) {
      return;
    }
    await dispatchRenames(renames, tabsBeforeRename);
    return;
  });

  // Drag-and-drop fallback. VS Code's Explorer occasionally lowers a
  // drag-drop into a delete-then-create pair instead of a rename, in
  // which case `onDidRenameFiles` never fires. We pair up the two events
  // by basename inside a short window and synthesize a `FileRename` so
  // the same scan + picker pipeline runs.
  const deleteDisposable = vscode.workspace.onDidDeleteFiles((event) => {
    const expiresAt = Date.now() + DRAG_DROP_PAIRING_WINDOW_MS;
    for (const uri of event.files) {
      if (uri.scheme !== "file") {
        continue;
      }
      const base = path.basename(uri.fsPath).toLowerCase();
      const list = recentlyDeleted.get(base) ?? [];
      list.push({ fsPath: uri.fsPath, expiresAt });
      recentlyDeleted.set(base, list);
    }
    // Drop expired entries opportunistically so the map never grows
    // without bound during a session of heavy editing.
    pruneExpired(recentlyDeleted);
  });

  const createDisposable = vscode.workspace.onDidCreateFiles(async (event) => {
    pruneExpired(recentlyDeleted);
    const tabsBeforeRename = captureOpenTabPaths();
    const renames: FileRename[] = [];
    for (const uri of event.files) {
      if (uri.scheme !== "file") {
        continue;
      }
      const base = path.basename(uri.fsPath).toLowerCase();
      const candidates = recentlyDeleted.get(base);
      if (!candidates || candidates.length === 0) {
        continue;
      }
      const match = candidates.shift()!;
      if (candidates.length === 0) {
        recentlyDeleted.delete(base);
      }
      const key = `${match.fsPath}|${uri.fsPath}`;
      if (processedRenames.has(key)) {
        // The rename pipeline already handled this pair in the same
        // tick — don't run the scanner twice.
        continue;
      }
      if (isRenameTriggerFile(uri.fsPath)) {
        renames.push({ oldPath: match.fsPath, newPath: uri.fsPath });
      }
    }
    if (renames.length === 0) {
      return;
    }
    await dispatchRenames(renames, tabsBeforeRename);
  });

  const findStaleDisposable = vscode.commands.registerCommand(
    "flare.findStaleReferences",
    async () => {
      const document = vscode.window.activeTextEditor?.document;
      let projectContext = document
        ? await projectResolver.resolveForFile(document.uri).catch(() => undefined)
        : undefined;
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
          "Flare: no .flprj project found in the workspace."
        );
        return;
      }
      const stale = await scanForStaleReferences(projectContext.projectRoot.fsPath);
      if (stale.length === 0) {
        vscode.window.showInformationMessage("Flare: no stale references found.");
        return;
      }
      vscode.window.showInformationMessage(
        `Flare: found ${stale.length} stale reference(s). Open the Problems panel for details.`
      );
      const collection = vscode.languages.createDiagnosticCollection("flare-stale");
      const grouped = new Map<string, vscode.Diagnostic[]>();
      for (const entry of stale) {
        const range = new vscode.Range(
          new vscode.Position(entry.line, entry.column),
          new vscode.Position(entry.line, entry.column + entry.length)
        );
        const diagnostic = new vscode.Diagnostic(
          range,
          `Stale reference: ${entry.rawHref}`,
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = "flare";
        diagnostic.code = "flare.stale-reference";
        const list = grouped.get(entry.filePath) ?? [];
        list.push(diagnostic);
        grouped.set(entry.filePath, list);
      }
      for (const [file, list] of grouped.entries()) {
        collection.set(vscode.Uri.file(file), list);
      }
    }
  );

  return vscode.Disposable.from(
    renameDisposable,
    deleteDisposable,
    createDisposable,
    findStaleDisposable
  );
}

/**
 * Time window inside which a delete event followed by a create event with
 * the same basename is treated as a single drag-drop move. Empirically the
 * Explorer fires the two events back-to-back inside the same tick, but a
 * generous window keeps the heuristic robust against debounced filesystem
 * watchers and slow disk I/O without producing spurious matches.
 */
const DRAG_DROP_PAIRING_WINDOW_MS = 1500;

async function scanForRenames(
  projectRoot: string,
  renames: FileRename[]
): Promise<AffectedReference[]> {
  // Pre-compute lowercased absolute old paths for fast comparison.
  const renameByLower = new Map<string, FileRename>();
  for (const rename of renames) {
    renameByLower.set(path.normalize(rename.oldPath).toLowerCase(), rename);
  }

  const files: string[] = [];
  await collectScanFiles(projectRoot, files);

  const affected: AffectedReference[] = [];
  for (const file of files) {
    if (renameByLower.has(path.normalize(file).toLowerCase())) {
      // Don't scan the renamed file itself for references to itself.
      continue;
    }
    const text = await readTextOrUndefined(file);
    if (text === undefined) {
      continue;
    }
    const fileDir = path.dirname(file);

    for (const pattern of REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match) {
        const rawValue = match[2];
        const valueStart = match.index + match[0].length - 1 - rawValue.length;
        const trimmed = rawValue.trim();
        if (trimmed.length === 0 || isExternal(trimmed) || trimmed.startsWith("#")) {
          match = pattern.exec(text);
          continue;
        }
        const [pathPart, anchorPart] = splitHash(trimmed);
        const resolved = resolveReferencePath(pathPart, fileDir, projectRoot);
        if (!resolved) {
          match = pattern.exec(text);
          continue;
        }
        const matchedRename = renameByLower.get(path.normalize(resolved).toLowerCase());
        if (!matchedRename) {
          match = pattern.exec(text);
          continue;
        }

        const rewrittenPath = rewriteReferencePath(pathPart, fileDir, matchedRename);
        const rewrittenHref = anchorPart === undefined ? rewrittenPath : `${rewrittenPath}#${anchorPart}`;
        const positionInfo = positionOf(text, valueStart);
        affected.push({
          filePath: file,
          rawHref: rawValue,
          rewrittenHref,
          start: valueStart,
          length: rawValue.length,
          line: positionInfo.line,
          column: positionInfo.column,
          matchedRename
        });
        match = pattern.exec(text);
      }
    }
  }
  return affected;
}

async function scanForStaleReferences(projectRoot: string): Promise<AffectedReference[]> {
  const files: string[] = [];
  await collectScanFiles(projectRoot, files);

  const stale: AffectedReference[] = [];
  for (const file of files) {
    const text = await readTextOrUndefined(file);
    if (text === undefined) {
      continue;
    }
    const fileDir = path.dirname(file);

    for (const pattern of REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match) {
        const rawValue = match[2];
        const valueStart = match.index + match[0].length - 1 - rawValue.length;
        const trimmed = rawValue.trim();
        if (trimmed.length === 0 || isExternal(trimmed) || trimmed.startsWith("#")) {
          match = pattern.exec(text);
          continue;
        }
        const [pathPart] = splitHash(trimmed);
        const resolved = resolveReferencePath(pathPart, fileDir, projectRoot);
        if (resolved && (await pathExists(resolved))) {
          match = pattern.exec(text);
          continue;
        }
        const positionInfo = positionOf(text, valueStart);
        stale.push({
          filePath: file,
          rawHref: rawValue,
          rewrittenHref: rawValue,
          start: valueStart,
          length: rawValue.length,
          line: positionInfo.line,
          column: positionInfo.column,
          matchedRename: { oldPath: "", newPath: "" }
        });
        match = pattern.exec(text);
      }
    }
  }
  return stale;
}

async function runRenamePicker(
  affected: AffectedReference[],
  tabsBeforeRename: Set<string>
): Promise<void> {
  const items: QuickPickReferenceItem[] = affected.map((reference) => ({
    label: `$(file) ${path.basename(reference.filePath)}`,
    description: `${reference.line + 1}:${reference.column + 1}`,
    detail: `${reference.rawHref}  →  ${reference.rewrittenHref}`,
    picked: true,
    reference
  }));

  const picks = await vscode.window.showQuickPick(items, {
    title: `Flare: Rename References (${affected.length} affected)`,
    placeHolder: "Uncheck any references you don't want updated, then press Enter to update all checked.",
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picks || picks.length === 0) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  // Group by file so we can compute positions in one document open.
  const byFile = new Map<string, AffectedReference[]>();
  for (const pick of picks) {
    const list = byFile.get(pick.reference.filePath) ?? [];
    list.push(pick.reference);
    byFile.set(pick.reference.filePath, list);
  }

  for (const [file, references] of byFile.entries()) {
    const document = await vscode.workspace.openTextDocument(file);
    for (const reference of references) {
      const range = new vscode.Range(
        document.positionAt(reference.start),
        document.positionAt(reference.start + reference.length)
      );
      edit.replace(document.uri, range, reference.rewrittenHref);
    }
  }

  // Apply, save, and clean up tabs in one helper call. Without it the user
  // ends up with one dirty unsaved tab per affected file (potentially
  // dozens for a real cross-project rename) and has to manually save and
  // close each one — same bug we just fixed in the rename condition tag
  // command.
  const result = await applyEditAndCleanUpTabs(edit, {
    progressTitle: `Flare: Updating ${picks.length} reference(s)…`,
    previouslyOpenPaths: tabsBeforeRename
  });
  if (result.applied) {
    logInfo(`Rewrote ${picks.length} reference(s) across ${byFile.size} file(s).`);
    vscode.window.showInformationMessage(
      `Flare: updated ${picks.length} reference(s) across ${byFile.size} file(s).`
    );
  } else {
    vscode.window.showWarningMessage(
      "Flare: failed to apply rename edits. Check the output channel for details."
    );
  }
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
    if (!entry.isFile()) {
      continue;
    }
    if (isScannableFile(entry.name)) {
      accumulator.push(path.join(rootDir, entry.name));
    }
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    let text = Buffer.from(bytes).toString("utf8");
    // Strip the UTF-8 BOM. VS Code's TextDocument strips it on load,
    // so leaving it in the scanner's string produces byte offsets that
    // are off by one relative to `document.positionAt()`, which
    // corrupts the rewritten range. See the matching note in
    // `renameConditionTagCommand.ts`.
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text;
  } catch {
    return undefined;
  }
}
