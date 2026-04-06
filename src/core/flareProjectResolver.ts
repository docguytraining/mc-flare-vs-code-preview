import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "./types";

const FLPRJ_EXT = ".flprj";
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
      const projectFile = entries.find((name) => name.toLowerCase().endsWith(FLPRJ_EXT));
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

    const variableFiles = extractFileMatches(projectText, FLVAR_REGEX)
      .map((candidate) => toAbsoluteUri(projectRoot, candidate));

    const referencedStylesheets = extractFileMatches(projectText, CSS_REGEX)
      .map((candidate) => toAbsoluteUri(projectRoot, candidate));

    return {
      projectFile,
      projectRoot: vscode.Uri.file(projectRoot),
      variableFiles,
      referencedStylesheets
    };
  }
}

function extractFileMatches(source: string, regex: RegExp): string[] {
  const matches = new Set<string>();
  const all = source.match(regex);
  if (!all) {
    return [];
  }

  for (const match of all) {
    matches.add(match.replace(/\\/g, "/"));
  }

  return [...matches];
}

function toAbsoluteUri(projectRoot: string, candidate: string): vscode.Uri {
  if (path.isAbsolute(candidate)) {
    return vscode.Uri.file(candidate);
  }
  return vscode.Uri.file(path.resolve(projectRoot, candidate));
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
  return Buffer.from(bytes).toString("utf8");
}
