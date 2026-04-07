import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "../core/types";

const CONDITION_TAG_SETS_DIR = path.join("Project", "ConditionTagSets");
const FLCTS_EXT = ".flcts";

/**
 * One condition tag definition discovered from a `.flcts` file. The qualified
 * name `<setName>.<tagName>` matches how Flare topics reference conditions in
 * `MadCap:conditions="…"` attributes.
 */
export interface ConditionTagDefinition {
  setName: string;
  tagName: string;
  qualifiedName: string;
  color: string | undefined;
  description: string | undefined;
  sourceFile: vscode.Uri;
}

interface CachedIndex {
  tags: ConditionTagDefinition[];
  byQualifiedName: Map<string, ConditionTagDefinition>;
}

/**
 * Per-project index of every `<setName>.<tagName>` condition declared in
 * `Project/ConditionTagSets` (any `.flcts` file, recursively). Cached per project root
 * and invalidated when any `.flcts` file changes on disk.
 *
 * The format Flare ships looks like:
 *
 *   <CatapultConditionTagSet>
 *     <ConditionTag Name="ContentDevOnly" BackgroundColor="#FF00FF" />
 *     <ConditionTag Name="Deprecated" BackgroundColor="#FFFF00" Comment="Old API" />
 *   </CatapultConditionTagSet>
 *
 * The set name is taken from the file's basename, mirroring Flare's own
 * `<setName>.<tagName>` convention.
 */
export class ConditionTagIndex {
  private readonly cache = new Map<string, Promise<CachedIndex>>();

  public async getEntries(projectContext: FlareProjectContext): Promise<ConditionTagDefinition[]> {
    const index = await this.getIndex(projectContext);
    return index.tags;
  }

  public async lookup(
    projectContext: FlareProjectContext,
    qualifiedName: string
  ): Promise<ConditionTagDefinition | undefined> {
    const index = await this.getIndex(projectContext);
    return index.byQualifiedName.get(qualifiedName);
  }

  public async hasTag(
    projectContext: FlareProjectContext,
    qualifiedName: string
  ): Promise<boolean> {
    const index = await this.getIndex(projectContext);
    return index.byQualifiedName.has(qualifiedName);
  }

  public invalidateForPath(fsPath: string): void {
    if (!fsPath.toLowerCase().endsWith(FLCTS_EXT)) {
      return;
    }
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

  private async getIndex(projectContext: FlareProjectContext): Promise<CachedIndex> {
    const projectRoot = projectContext.projectRoot.fsPath;
    const cached = this.cache.get(projectRoot);
    if (cached) {
      return cached;
    }
    const loading = this.scan(projectRoot);
    this.cache.set(projectRoot, loading);
    try {
      return await loading;
    } catch (error) {
      this.cache.delete(projectRoot);
      throw error;
    }
  }

  private async scan(projectRoot: string): Promise<CachedIndex> {
    const scanRoot = path.join(projectRoot, CONDITION_TAG_SETS_DIR);
    const files: string[] = [];
    await collectFlctsFiles(scanRoot, files);

    const tags: ConditionTagDefinition[] = [];
    const byQualifiedName = new Map<string, ConditionTagDefinition>();

    for (const file of files) {
      const text = await readTextOrEmpty(file);
      if (!text) {
        continue;
      }
      const setName = stripBom(path.basename(file, path.extname(file)));
      for (const parsed of parseConditionTags(text)) {
        const qualifiedName = `${setName}.${parsed.tagName}`;
        const definition: ConditionTagDefinition = {
          setName,
          tagName: parsed.tagName,
          qualifiedName,
          color: parsed.color,
          description: parsed.description,
          sourceFile: vscode.Uri.file(file)
        };
        tags.push(definition);
        if (!byQualifiedName.has(qualifiedName)) {
          byQualifiedName.set(qualifiedName, definition);
        }
      }
    }

    tags.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    return { tags, byQualifiedName };
  }
}

interface ParsedTag {
  tagName: string;
  color: string | undefined;
  description: string | undefined;
}

const CONDITION_TAG_REGEX = /<ConditionTag\b([^>]*?)\/?>/gi;
const NAME_ATTR_REGEX = /\bName\s*=\s*["']([^"']+)["']/i;
const COLOR_ATTR_REGEX = /\b(?:BackgroundColor|Color|color)\s*=\s*["']([^"']+)["']/i;
const COMMENT_ATTR_REGEX = /\b(?:Comment|Description)\s*=\s*["']([^"']+)["']/i;

function parseConditionTags(xmlContent: string): ParsedTag[] {
  const text = stripBom(xmlContent);
  const parsed: ParsedTag[] = [];
  CONDITION_TAG_REGEX.lastIndex = 0;
  let match = CONDITION_TAG_REGEX.exec(text);
  while (match) {
    const attributes = match[1] ?? "";
    const name = NAME_ATTR_REGEX.exec(attributes)?.[1]?.trim();
    if (name) {
      parsed.push({
        tagName: name,
        color: COLOR_ATTR_REGEX.exec(attributes)?.[1]?.trim(),
        description: COMMENT_ATTR_REGEX.exec(attributes)?.[1]?.trim()
      });
    }
    match = CONDITION_TAG_REGEX.exec(text);
  }
  return parsed;
}

async function collectFlctsFiles(rootDir: string, accumulator: string[]): Promise<void> {
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
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectFlctsFiles(fullPath, accumulator);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(FLCTS_EXT)) {
      accumulator.push(fullPath);
    }
  }
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
