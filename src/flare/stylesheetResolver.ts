import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext, StylesheetBundle } from "../core/types";

const LINK_STYLESHEET_REGEX = /<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
const IMPORT_REGEX = /@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*;/gi;

export async function resolveStylesheets(
  document: vscode.TextDocument,
  htmlContent: string,
  projectContext: FlareProjectContext | undefined
): Promise<StylesheetBundle> {
  const discovered = new Map<string, vscode.Uri>();

  for (const href of findHtmlStylesheets(htmlContent)) {
    const uri = resolveAgainstDocument(document.uri, href);
    if (uri) {
      discovered.set(uri.fsPath, uri);
    }
  }

  if (projectContext) {
    for (const referenced of projectContext.referencedStylesheets) {
      discovered.set(referenced.fsPath, referenced);
    }

    const stylesheetsDir = path.join(projectContext.projectRoot.fsPath, "Stylesheets");
    for (const candidate of await findCssFiles(stylesheetsDir)) {
      discovered.set(candidate.fsPath, candidate);
    }
  }

  const missingStylesheets: string[] = [];
  const inlinedCss: Array<{ source: vscode.Uri; content: string }> = [];

  for (const stylesheet of discovered.values()) {
    const css = await readTextOrUndefined(stylesheet.fsPath);
    if (css === undefined) {
      missingStylesheets.push(stylesheet.fsPath);
      continue;
    }

    const expanded = await expandImports(css, path.dirname(stylesheet.fsPath), new Set<string>([
      stylesheet.fsPath
    ]));

    inlinedCss.push({ source: stylesheet, content: expanded });
  }

  return {
    stylesheets: [...discovered.values()],
    inlinedCss,
    missingStylesheets
  };
}

async function expandImports(
  cssContent: string,
  baseDir: string,
  visited: Set<string>
): Promise<string> {
  let result = cssContent;

  IMPORT_REGEX.lastIndex = 0;
  const imports = [...cssContent.matchAll(IMPORT_REGEX)].map((match) => match[1]);

  for (const importedPath of imports) {
    const resolvedPath = path.resolve(baseDir, importedPath);
    if (visited.has(resolvedPath)) {
      continue;
    }

    visited.add(resolvedPath);
    const importedContent = await readTextOrUndefined(resolvedPath);
    if (!importedContent) {
      continue;
    }

    const expandedImport = await expandImports(importedContent, path.dirname(resolvedPath), visited);
    result = result.replace(new RegExp(escapeRegExp(`@import \"${importedPath}\";`), "g"), expandedImport);
    result = result.replace(new RegExp(escapeRegExp(`@import '${importedPath}';`), "g"), expandedImport);
    result = result.replace(new RegExp(escapeRegExp(`@import url(\"${importedPath}\");`), "g"), expandedImport);
    result = result.replace(new RegExp(escapeRegExp(`@import url('${importedPath}');`), "g"), expandedImport);
  }

  return result;
}

function findHtmlStylesheets(html: string): string[] {
  const found: string[] = [];
  LINK_STYLESHEET_REGEX.lastIndex = 0;

  let match = LINK_STYLESHEET_REGEX.exec(html);
  while (match) {
    if (match[1]) {
      found.push(match[1]);
    }
    match = LINK_STYLESHEET_REGEX.exec(html);
  }

  return [...new Set(found)];
}

function resolveAgainstDocument(documentUri: vscode.Uri, href: string): vscode.Uri | undefined {
  const trimmed = href.trim();
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("#")
  ) {
    return undefined;
  }

  const baseDir = path.dirname(documentUri.fsPath);
  return vscode.Uri.file(path.resolve(baseDir, trimmed));
}

async function findCssFiles(dirPath: string): Promise<vscode.Uri[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: vscode.Uri[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await findCssFiles(fullPath)) {
        found.push(nested);
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".css")) {
      found.push(vscode.Uri.file(fullPath));
    }
  }

  return found;
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
