import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FlareProjectContext, VariableResolutionResult } from "../core/types";

const VARIABLE_REFERENCE_REGEX = /<MadCap:variable\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
const VARIABLE_BLOCK_REGEX = /<Variable\b([^>]*)>([\s\S]*?)<\/Variable>/gi;
const VARIABLE_SELF_CLOSING_REGEX = /<Variable\b([^>]*)\/>/gi;
const NAME_ATTR_REGEX = /\bName\s*=\s*["']([^"']+)["']/i;
const VALUE_ATTR_REGEX = /\bValue\s*=\s*["']([^"']*)["']/i;
const VALUE_TAG_REGEX = /<Value\b[^>]*>([\s\S]*?)<\/Value>/i;

interface ParsedVariable {
  name: string;
  value: string;
}

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

  // Each variable lives at two keys in the map:
  //   1. Its fully qualified name `<setName>.<varName>` (preferred — matches
  //      how Flare topics reference variables in this project).
  //   2. Its bare `<varName>` (fallback — for projects that don't qualify
  //      references, and for the existing fixture style).
  //
  // The bare key follows last-write-wins; the qualified key is unique.
  const variables = new Map<string, string>();

  // Deduplicate variable file URIs by absolute path so a file referenced by
  // both the .flprj and the convention scan is only parsed once.
  const seenFiles = new Set<string>();
  for (const fileUri of projectContext.variableFiles) {
    const normalized = path.normalize(fileUri.fsPath);
    if (seenFiles.has(normalized)) {
      continue;
    }
    seenFiles.add(normalized);

    const fileContent = await readTextOrEmpty(normalized);
    if (!fileContent) {
      continue;
    }

    const setName = stripBom(path.basename(normalized, path.extname(normalized)));
    for (const parsed of parseFlareVariables(fileContent)) {
      variables.set(`${setName}.${parsed.name}`, parsed.value);
      if (!variables.has(parsed.name)) {
        variables.set(parsed.name, parsed.value);
      }
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
    if (match[1]) {
      matches.push(match[1]);
    }
    match = VARIABLE_REFERENCE_REGEX.exec(html);
  }

  return matches;
}

function uniqueReferences(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Parses a `.flvar` file. Flare's canonical format stores the variable value
 * as the element's text content:
 *
 *   <Variable Name="Foo">value</Variable>
 *
 * Older or hand-rolled variations sometimes use a `<Value>` child element or
 * a `Value="…"` attribute. We accept all three with this precedence:
 * element text > `<Value>` child > `Value=` attribute.
 */
function parseFlareVariables(xmlContent: string): ParsedVariable[] {
  const text = stripBom(xmlContent);
  const parsed: ParsedVariable[] = [];

  VARIABLE_BLOCK_REGEX.lastIndex = 0;
  let blockMatch = VARIABLE_BLOCK_REGEX.exec(text);
  while (blockMatch) {
    const attributes = blockMatch[1] ?? "";
    const body = blockMatch[2] ?? "";
    const name = NAME_ATTR_REGEX.exec(attributes)?.[1]?.trim();
    if (name) {
      parsed.push({ name, value: extractVariableValue(body, attributes) });
    }
    blockMatch = VARIABLE_BLOCK_REGEX.exec(text);
  }

  VARIABLE_SELF_CLOSING_REGEX.lastIndex = 0;
  let selfMatch = VARIABLE_SELF_CLOSING_REGEX.exec(text);
  while (selfMatch) {
    const attributes = selfMatch[1] ?? "";
    const name = NAME_ATTR_REGEX.exec(attributes)?.[1]?.trim();
    if (name) {
      parsed.push({ name, value: extractVariableValue("", attributes) });
    }
    selfMatch = VARIABLE_SELF_CLOSING_REGEX.exec(text);
  }

  return parsed;
}

function extractVariableValue(body: string, attributes: string): string {
  // 1. <Value> child element wins if present (rare, but unambiguous).
  const valueTag = VALUE_TAG_REGEX.exec(body)?.[1];
  if (valueTag !== undefined && valueTag.trim().length > 0) {
    return decodeXml(valueTag.trim());
  }

  // 2. Element text content with any nested tags stripped. This is the
  //    canonical Flare format.
  const textContent = body.replace(/<[^>]+>/g, "").trim();
  if (textContent.length > 0) {
    return decodeXml(textContent);
  }

  // 3. `Value="…"` attribute fallback.
  const attrValue = VALUE_ATTR_REGEX.exec(attributes)?.[1];
  if (attrValue !== undefined) {
    return decodeXml(attrValue.trim());
  }

  return "";
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_full, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(path.resolve(filePath));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}
