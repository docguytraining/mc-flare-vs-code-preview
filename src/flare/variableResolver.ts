import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FlareProjectContext, VariableResolutionResult } from "../core/types";

const VARIABLE_REFERENCE_REGEX = /<MadCap:variable\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>|\$\{([A-Za-z0-9_.-]+)\}/gi;
const VARIABLE_BLOCK_REGEX = /<Variable\b[^>]*\bName\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/Variable>/gi;
const VALUE_TAG_REGEX = /<Value\b[^>]*>([\s\S]*?)<\/Value>/i;
const VALUE_ATTR_REGEX = /\bValue\s*=\s*["']([^"']*)["']/i;

export async function resolveVariables(
  htmlContent: string,
  projectContext: FlareProjectContext | undefined
): Promise<VariableResolutionResult> {
  if (!projectContext) {
    return {
      variables: new Map<string, string>(),
      unresolvedReferences: uniqueReferences(findVariableReferences(htmlContent))
    };
  }

  const variables = new Map<string, string>();
  for (const fileUri of projectContext.variableFiles) {
    const fileContent = await readTextOrEmpty(fileUri.fsPath);
    if (!fileContent) {
      continue;
    }

    for (const parsed of parseFlareVariables(fileContent)) {
      variables.set(parsed.name, parsed.value);
    }
  }

  const unresolvedReferences: string[] = [];
  for (const reference of uniqueReferences(findVariableReferences(htmlContent))) {
    if (!variables.has(reference)) {
      unresolvedReferences.push(reference);
    }
  }

  return { variables, unresolvedReferences };
}

function findVariableReferences(html: string): string[] {
  const matches: string[] = [];
  VARIABLE_REFERENCE_REGEX.lastIndex = 0;

  let match = VARIABLE_REFERENCE_REGEX.exec(html);
  while (match) {
    const name = match[1] || match[2];
    if (name) {
      matches.push(name);
    }
    match = VARIABLE_REFERENCE_REGEX.exec(html);
  }

  return matches;
}

function uniqueReferences(items: string[]): string[] {
  return [...new Set(items)];
}

function parseFlareVariables(xmlContent: string): Array<{ name: string; value: string }> {
  const parsed: Array<{ name: string; value: string }> = [];

  VARIABLE_BLOCK_REGEX.lastIndex = 0;
  let match = VARIABLE_BLOCK_REGEX.exec(xmlContent);
  while (match) {
    const name = match[1]?.trim();
    const body = match[2] ?? "";
    if (!name) {
      match = VARIABLE_BLOCK_REGEX.exec(xmlContent);
      continue;
    }

    let value = "";
    const tagValue = VALUE_TAG_REGEX.exec(body)?.[1];
    if (tagValue !== undefined) {
      value = decodeXml(tagValue.trim());
    } else {
      const attrValue = VALUE_ATTR_REGEX.exec(body)?.[1] ?? "";
      value = decodeXml(attrValue.trim());
    }

    parsed.push({ name, value });
    match = VARIABLE_BLOCK_REGEX.exec(xmlContent);
  }

  return parsed;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(path.resolve(filePath));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}
