import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext } from "../core/types";

const TARGETS_DIR = path.join("Project", "Targets");
const FLTAR_EXT = ".fltar";

export const SHOW_EVERYTHING_TARGET_ID = "__show_everything__";
export const PROJECT_DEFAULT_TARGET_ID = "__project_default__";

/** A discovered build target plus its conditional expression (if any). */
export interface TargetEntry {
  id: string;
  displayName: string;
  expression: string | undefined;
  sourceFile: vscode.Uri | undefined;
  isShowEverything: boolean;
  isProjectDefault: boolean;
}

const TARGET_CONDITIONAL_REGEX =
  /\b(?:ConditionExpression|ConditionalExpression|PreviewConditionalExpression)\s*=\s*"([^"]*)"/i;

/**
 * Walks `Project/Targets` for `.fltar` files, extracts each target's conditional
 * expression, and returns the discovered list. The first two entries are
 * always the synthetic "Show everything" and "(Project default)" choices so
 * the picker can present them above real targets.
 */
export async function discoverTargets(
  projectContext: FlareProjectContext
): Promise<TargetEntry[]> {
  const projectRoot = projectContext.projectRoot.fsPath;
  const projectFilePath = projectContext.projectFile.fsPath;

  const targets: TargetEntry[] = [
    {
      id: SHOW_EVERYTHING_TARGET_ID,
      displayName: "Show everything",
      expression: undefined,
      sourceFile: undefined,
      isShowEverything: true,
      isProjectDefault: false
    }
  ];

  const projectDefault = await readProjectPreviewExpression(projectFilePath);
  targets.push({
    id: PROJECT_DEFAULT_TARGET_ID,
    displayName: "(Project default)",
    expression: projectDefault,
    sourceFile: projectContext.projectFile,
    isShowEverything: false,
    isProjectDefault: true
  });

  const targetFiles: string[] = [];
  await collectFltarFiles(path.join(projectRoot, TARGETS_DIR), targetFiles);
  for (const file of targetFiles) {
    const text = await readTextOrEmpty(file);
    if (!text) {
      continue;
    }
    const expression = TARGET_CONDITIONAL_REGEX.exec(text)?.[1] ?? undefined;
    const baseName = path.basename(file, path.extname(file));
    targets.push({
      id: `target:${path.relative(projectRoot, file).replace(/\\/g, "/")}`,
      displayName: baseName,
      expression,
      sourceFile: vscode.Uri.file(file),
      isShowEverything: false,
      isProjectDefault: false
    });
  }

  return targets;
}

async function readProjectPreviewExpression(
  projectFilePath: string
): Promise<string | undefined> {
  const text = await readTextOrEmpty(projectFilePath);
  if (!text) {
    return undefined;
  }
  return TARGET_CONDITIONAL_REGEX.exec(text)?.[1] ?? undefined;
}

async function collectFltarFiles(rootDir: string, accumulator: string[]): Promise<void> {
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
      await collectFltarFiles(fullPath, accumulator);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(FLTAR_EXT)) {
      accumulator.push(fullPath);
    }
  }
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(filePath);
    let text = Buffer.from(bytes).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text;
  } catch {
    return "";
  }
}
