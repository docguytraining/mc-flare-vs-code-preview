import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "./types";

const FLPRJ_EXT = ".flprj";
const FLVAR_EXT = ".flvar";
const VARIABLE_SETS_DIR = path.join("Project", "VariableSets");
const FLVAR_REGEX = /[\w./\\-]+\.flvar/gi;
const CSS_REGEX = /[\w./\\-]+\.css/gi;

export class FlareProjectResolver {
  private readonly fileToProjectRoot = new Map<string, string>();
  private readonly projectCache = new Map<string, FlareProjectContext>();

  public async resolveForFile(fileUri: vscode.Uri): Promise<FlareProjectContext | undefined> {
    const containingDir = path.dirname(fileUri.fsPath);

    const cachedRoot = this.fileToProjectRoot.get(containingDir);
    if (cachedRoot) {
      const cachedProject = this.projectCache.get(cachedRoot);
      if (cachedProject) {
        return cachedProject;
      }
    }

    const projectFile = await this.findNearestProjectFile(containingDir);
    if (!projectFile) {
      return undefined;
    }

    const projectRoot = path.dirname(projectFile.fsPath);
    const cacheHit = this.projectCache.get(projectRoot);
    if (cacheHit) {
      this.fileToProjectRoot.set(containingDir, projectRoot);
      return cacheHit;
    }

    const context = await this.parseProjectContext(projectFile);
    this.projectCache.set(projectRoot, context);
    this.fileToProjectRoot.set(containingDir, projectRoot);
    return context;
  }

  public invalidateForPath(fsPath: string): void {
    const normalized = path.normalize(fsPath);

    for (const [projectRoot] of this.projectCache) {
      if (normalized.startsWith(projectRoot)) {
        this.projectCache.delete(projectRoot);
      }
    }

    for (const [dirPath, projectRoot] of this.fileToProjectRoot) {
      if (normalized.startsWith(projectRoot) || normalized.startsWith(dirPath)) {
        this.fileToProjectRoot.delete(dirPath);
      }
    }
  }

  private async findNearestProjectFile(startDir: string): Promise<vscode.Uri | undefined> {
    let currentDir = path.resolve(startDir);

    while (true) {
      const entries = await safeReadDir(currentDir);
      const projectFile = entries.find(
        (name) => !isAppleDoubleName(name) && name.toLowerCase().endsWith(FLPRJ_EXT)
      );
      if (projectFile) {
        return vscode.Uri.file(path.join(currentDir, projectFile));
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return undefined;
      }
      currentDir = parent;
    }
  }

  private async parseProjectContext(projectFile: vscode.Uri): Promise<FlareProjectContext> {
    const projectRoot = path.dirname(projectFile.fsPath);
    const projectText = await readTextFile(projectFile.fsPath);

    // Variable file discovery has two sources, merged and deduped:
    //   1. Recursive scan of `Project/VariableSets/**/*.flvar`. This is how
    //      Flare itself locates variable sets, and works whether or not the
    //      .flprj enumerates them.
    //   2. Filename matches inside the .flprj XML. Some projects import
    //      variable sets from sibling projects via paths recorded here, so
    //      we keep honoring them even if they live outside VariableSets/.
    const variableFileSet = new Map<string, vscode.Uri>();

    const conventionScanRoot = path.join(projectRoot, VARIABLE_SETS_DIR);
    for (const file of await collectFlvarFiles(conventionScanRoot)) {
      variableFileSet.set(path.normalize(file), vscode.Uri.file(file));
    }

    for (const candidate of extractFileMatches(projectText, FLVAR_REGEX)) {
      const absolute = resolveProjectPath(projectRoot, candidate);
      const normalized = path.normalize(absolute);
      if (!variableFileSet.has(normalized)) {
        variableFileSet.set(normalized, vscode.Uri.file(absolute));
      }
    }

    const referencedStylesheets: vscode.Uri[] = [];
    const seenStylesheets = new Set<string>();
    for (const candidate of extractFileMatches(projectText, CSS_REGEX)) {
      const absolute = resolveProjectPath(projectRoot, candidate);
      const normalized = path.normalize(absolute);
      if (!seenStylesheets.has(normalized)) {
        seenStylesheets.add(normalized);
        referencedStylesheets.push(vscode.Uri.file(absolute));
      }
    }

    return {
      projectFile,
      projectRoot: vscode.Uri.file(projectRoot),
      variableFiles: [...variableFileSet.values()],
      referencedStylesheets
    };
  }
}

function extractFileMatches(source: string, regex: RegExp): string[] {
  const matches = new Set<string>();
  regex.lastIndex = 0;
  const all = source.match(regex);
  if (!all) {
    return [];
  }

  for (const match of all) {
    if (isAppleDoubleName(path.basename(match))) {
      continue;
    }
    matches.add(match.replace(/\\/g, "/"));
  }

  return [...matches];
}

/**
 * Resolves a path that appeared in a `.flprj`. A leading `/` (or `\`) means
 * "project-root-relative", **not** filesystem-absolute, which is the trap
 * `path.resolve` would otherwise fall into.
 */
function resolveProjectPath(projectRoot: string, candidate: string): string {
  const normalized = candidate.replace(/\\/g, "/").trim();
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    // Windows-style drive-letter absolute path; pass through.
    return path.normalize(normalized);
  }
  if (normalized.startsWith("/")) {
    return path.normalize(path.join(projectRoot, normalized.slice(1)));
  }
  return path.normalize(path.resolve(projectRoot, normalized));
}

async function collectFlvarFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  await walkForFlvar(rootDir, found);
  return found;
}

async function walkForFlvar(dir: string, accumulator: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isAppleDoubleName(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForFlvar(fullPath, accumulator);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(FLVAR_EXT)) {
      accumulator.push(fullPath);
    }
  }
}

function isAppleDoubleName(name: string): boolean {
  return name.startsWith("._");
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function readTextFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  let text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}
