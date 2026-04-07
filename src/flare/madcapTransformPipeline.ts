import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectContext, TransformResult } from "../core/types";
import { ConditionExpression, alwaysRender } from "./conditionExpression";
import { applyConditions } from "./conditionRenderer";

export interface TransformContext {
  variables: Map<string, string>;
  projectContext: FlareProjectContext | undefined;
  currentDocument: vscode.Uri;
  conditionExpression?: ConditionExpression;
  showConditionBadges?: boolean;
  collectedConditions?: {
    elementConditionCounts: Map<string, number>;
    snippetConditionCounts: Map<string, number>;
    hiddenCount: number;
  };
}

export interface HandlerContext {
  warnings: string[];
}

export interface TransformHandler {
  id: string;
  run(
    htmlContent: string,
    transformContext: TransformContext,
    handlerContext: HandlerContext
  ): Promise<string> | string;
}

const MADCAP_VARIABLE_REGEX = /<MadCap:variable\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>(?:\s*<\/MadCap:variable>)?/gi;
const CONDITIONAL_BLOCK_REGEX = /<MadCap:conditionalBlock\b([^>]*)>([\s\S]*?)<\/MadCap:conditionalBlock>/gi;
const DROPDOWN_REGEX = /<MadCap:(dropDown|expandableArea)\b([^>]*)>([\s\S]*?)<\/MadCap:\1>/gi;
const HOTSPOT_REGEX = /<MadCap:dropDownHotspot\b[^>]*>([\s\S]*?)<\/MadCap:dropDownHotspot>/i;
const SNIPPET_SELF_CLOSING_REGEX = /<MadCap:(snippet|snippetBlock)\b([^>]*)\/>/gi;
const SNIPPET_BLOCK_REGEX = /<MadCap:(snippet|snippetBlock)\b([^>]*)>([\s\S]*?)<\/MadCap:\1>/gi;
const XREF_SELF_CLOSING_REGEX = /<MadCap:xref\b([^>]*)\/>/gi;
const XREF_BLOCK_REGEX = /<MadCap:xref\b([^>]*)>([\s\S]*?)<\/MadCap:xref>/gi;
const KEYWORD_TAG_REGEX = /<MadCap:keyword\b[^>]*\/>|<MadCap:keyword\b[^>]*>[\s\S]*?<\/MadCap:keyword>/gi;
const ANNOTATION_BLOCK_REGEX = /<MadCap:annotation\b[^>]*>([\s\S]*?)<\/MadCap:annotation>/gi;
const ANNOTATION_SELF_CLOSING_REGEX = /<MadCap:annotation\b[^>]*\/>/gi;
const REMAINING_MADCAP_TAG_REGEX = /<\/?\s*MadCap:([A-Za-z0-9_-]+)\b[^>]*>/gi;

const variableTransformHandler: TransformHandler = {
  id: "variables",
  run(htmlContent, transformContext, handlerContext) {
    return replaceMadcapVariables(htmlContent, transformContext.variables, handlerContext.warnings);
  }
};

const conditionalTransformHandler: TransformHandler = {
  id: "conditionals",
  run(htmlContent, transformContext, handlerContext) {
    // First, apply per-element conditions against the active target
    // expression. Hidden elements are stripped here so the legacy
    // <MadCap:conditionalBlock> handler that runs immediately afterward
    // doesn't need to know about it.
    const expression = transformContext.conditionExpression ?? alwaysRender();
    const result = applyConditions(htmlContent, {
      expression,
      showBadges: transformContext.showConditionBadges ?? false
    });
    if (transformContext.collectedConditions) {
      transformContext.collectedConditions.elementConditionCounts =
        result.elementConditionCounts;
      transformContext.collectedConditions.snippetConditionCounts =
        result.snippetConditionCounts;
      transformContext.collectedConditions.hiddenCount = result.hiddenCount;
    }
    if (result.hiddenCount > 0) {
      handlerContext.warnings.push(
        `Hidden ${result.hiddenCount} element(s) by active target conditions.`
      );
    }
    return replaceConditionalBlocks(result.html, handlerContext.warnings);
  }
};

const dropDownTransformHandler: TransformHandler = {
  id: "dropdown-expandable",
  run(htmlContent) {
    return replaceDropDowns(htmlContent);
  }
};

const snippetTransformHandler: TransformHandler = {
  id: "snippets",
  async run(htmlContent, transformContext, handlerContext) {
    return replaceSnippets(htmlContent, transformContext, handlerContext.warnings);
  }
};

const xrefTransformHandler: TransformHandler = {
  id: "xrefs",
  run(htmlContent) {
    return replaceXrefs(htmlContent);
  }
};

/**
 * Silently drops authoring/metadata tags whose content (or absence of
 * content) should never appear in the rendered preview. Runs before the
 * unsupported-tag fallback so these don't pollute the warning list.
 */
const metadataDropHandler: TransformHandler = {
  id: "metadata-drop",
  run(htmlContent) {
    let transformed = htmlContent.replace(KEYWORD_TAG_REGEX, "");
    transformed = transformed.replace(
      ANNOTATION_BLOCK_REGEX,
      (_full, body: string) => body
    );
    transformed = transformed.replace(ANNOTATION_SELF_CLOSING_REGEX, "");
    return transformed;
  }
};

const unsupportedTagTransformHandler: TransformHandler = {
  id: "unsupported-markers",
  run(htmlContent, _transformContext, handlerContext) {
    return replaceUnsupportedTags(htmlContent, handlerContext.warnings);
  }
};

const REGISTERED_HANDLERS: TransformHandler[] = [
  variableTransformHandler,
  conditionalTransformHandler,
  dropDownTransformHandler,
  snippetTransformHandler,
  xrefTransformHandler,
  metadataDropHandler,
  unsupportedTagTransformHandler
];

export async function transformMadcapContent(
  htmlContent: string,
  context: TransformContext
): Promise<TransformResult> {
  const warnings: string[] = [];
  const handlerContext: HandlerContext = { warnings };
  let transformed = htmlContent;

  for (const handler of REGISTERED_HANDLERS) {
    transformed = await handler.run(transformed, context, handlerContext);
  }

  return {
    html: transformed,
    warnings: dedupe(warnings)
  };
}

function replaceMadcapVariables(
  htmlContent: string,
  variables: Map<string, string>,
  warnings: string[]
): string {
  return htmlContent.replace(MADCAP_VARIABLE_REGEX, (_full, name: string) => {
    const value = variables.get(name);
    if (value === undefined) {
      warnings.push(`Missing value for MadCap variable '${name}'.`);
      return `<span class="madcap-missing-variable" data-name="${escapeHtml(name)}">[${escapeHtml(name)}]</span>`;
    }
    return escapeHtml(value);
  });
}

function replaceConditionalBlocks(htmlContent: string, warnings: string[]): string {
  return htmlContent.replace(CONDITIONAL_BLOCK_REGEX, (_full, attributes: string, content: string) => {
    const condition = readAttribute(attributes, ["MadCap:conditions", "conditions", "condition"]);
    if (shouldRenderCondition(condition)) {
      return `<div class="madcap-conditional">${content}</div>`;
    }

    warnings.push(`Conditional block hidden due to condition '${condition ?? "(empty)"}'.`);
    return "";
  });
}

function replaceDropDowns(htmlContent: string): string {
  return htmlContent.replace(DROPDOWN_REGEX, (_full, tagName: string, attributes: string, content: string) => {
    const declaredTitle = readAttribute(attributes, ["title", "MadCap:dropDownHotspot"]);
    const hotspotMatch = HOTSPOT_REGEX.exec(content);
    HOTSPOT_REGEX.lastIndex = 0;

    let body = content;
    let hotspotTitle = "";
    if (hotspotMatch) {
      hotspotTitle = stripTags(hotspotMatch[1]).trim();
      body = content.replace(HOTSPOT_REGEX, "");
    }

    const title = declaredTitle?.trim() || hotspotTitle || (tagName === "dropDown" ? "Details" : "Expand");
    return `<details class="madcap-${tagName.toLowerCase()}"><summary>${escapeHtml(title)}</summary><div class="madcap-expandable-content">${body}</div></details>`;
  });
}

async function replaceSnippets(
  htmlContent: string,
  context: TransformContext,
  warnings: string[]
): Promise<string> {
  let transformed = htmlContent;

  transformed = await replaceMatchesAsync(
    transformed,
    SNIPPET_SELF_CLOSING_REGEX,
    async (_full: string, _tagName: string, attributes: string) => {
      const src = readAttribute(attributes, ["src", "source"]);
      return loadSnippet(src, context, warnings);
    }
  );

  transformed = await replaceMatchesAsync(
    transformed,
    SNIPPET_BLOCK_REGEX,
    async (_full: string, _tagName: string, attributes: string) => {
      const src = readAttribute(attributes, ["src", "source"]);
      return loadSnippet(src, context, warnings);
    }
  );

  return transformed;
}

function replaceXrefs(htmlContent: string): string {
  let transformed = htmlContent.replace(XREF_BLOCK_REGEX, (_full, attributes: string, body: string) => {
    const href = readAttribute(attributes, ["href"]) ?? "";
    const text = stripTags(body).trim() || href || "cross-reference";
    return renderXrefAnchor(href, text);
  });

  transformed = transformed.replace(XREF_SELF_CLOSING_REGEX, (_full, attributes: string) => {
    const href = readAttribute(attributes, ["href"]) ?? "";
    return renderXrefAnchor(href, href || "cross-reference");
  });

  return transformed;
}

function renderXrefAnchor(href: string, text: string): string {
  const encodedHref = escapeHtml(href);
  return `<a class="flare-xref" data-flare-xref="${encodedHref}" href="#">${escapeHtml(text)}</a>`;
}

function replaceUnsupportedTags(htmlContent: string, warnings: string[]): string {
  return htmlContent.replace(REMAINING_MADCAP_TAG_REGEX, (_full, tagName: string) => {
    warnings.push(`Unsupported MadCap tag encountered: ${tagName}`);
    return `<span class="madcap-unsupported-tag" data-tag="${escapeHtml(tagName)}">[Unsupported MadCap:${escapeHtml(tagName)}]</span>`;
  });
}

function shouldRenderCondition(conditionValue: string | undefined): boolean {
  if (!conditionValue) {
    return true;
  }

  const normalized = conditionValue.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "none" ||
    normalized === "exclude" ||
    normalized === "hide"
  ) {
    return false;
  }

  return true;
}

async function loadSnippet(
  snippetSource: string | undefined,
  context: TransformContext,
  warnings: string[]
): Promise<string> {
  if (!snippetSource) {
    warnings.push("Snippet tag missing src/source attribute.");
    return "<div class=\"madcap-missing-snippet\">[Snippet missing source]</div>";
  }

  const resolvedPath = resolveSnippetPath(snippetSource, context);
  if (!resolvedPath) {
    warnings.push(`Snippet path could not be resolved: ${snippetSource}`);
    return `<div class=\"madcap-missing-snippet\">[Snippet not found: ${escapeHtml(snippetSource)}]</div>`;
  }

  try {
    const bytes = await fs.readFile(resolvedPath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    warnings.push(`Snippet file missing: ${resolvedPath}`);
    return `<div class=\"madcap-missing-snippet\">[Snippet not found: ${escapeHtml(snippetSource)}]</div>`;
  }
}

function resolveSnippetPath(source: string, context: TransformContext): string | undefined {
  const normalized = source.replace(/\\/g, "/");

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  const documentDir = path.dirname(context.currentDocument.fsPath);
  const candidateFromDoc = path.resolve(documentDir, normalized);
  if (pathExists(candidateFromDoc)) {
    return candidateFromDoc;
  }

  if (context.projectContext) {
    const candidateFromProject = path.resolve(context.projectContext.projectRoot.fsPath, normalized);
    if (pathExists(candidateFromProject)) {
      return candidateFromProject;
    }
  }

  return candidateFromDoc;
}

function pathExists(candidate: string): boolean {
  return existsSync(candidate);
}

function readAttribute(source: string, names: string[]): string | undefined {
  for (const name of names) {
    const regex = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = regex.exec(source);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

async function replaceMatchesAsync(
  input: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>
): Promise<string> {
  regex.lastIndex = 0;
  let result = "";
  let lastIndex = 0;

  let match = regex.exec(input);
  while (match) {
    result += input.slice(lastIndex, match.index);
    result += await replacer(...match);
    lastIndex = match.index + match[0].length;
    match = regex.exec(input);
  }

  result += input.slice(lastIndex);
  return result;
}
