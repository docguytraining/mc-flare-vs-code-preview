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
// dropDownHead / dropDownBody are structural wrapper elements inside a
// <MadCap:dropDown>. The dropDown handler already consumes the hotspot, but
// the wrappers themselves survive into the rendered <details> body unless we
// also strip them — leaving their inner content intact.
const DROPDOWN_HEAD_REGEX = /<MadCap:dropDownHead\b[^>]*>([\s\S]*?)<\/MadCap:dropDownHead>/gi;
const DROPDOWN_BODY_REGEX = /<MadCap:dropDownBody\b[^>]*>([\s\S]*?)<\/MadCap:dropDownBody>/gi;
const SNIPPET_SELF_CLOSING_REGEX = /<MadCap:(snippet|snippetBlock|snippetText)\b([^>]*)\/>/gi;
const SNIPPET_BLOCK_REGEX = /<MadCap:(snippet|snippetBlock|snippetText)\b([^>]*)>([\s\S]*?)<\/MadCap:\1>/gi;
const XREF_SELF_CLOSING_REGEX = /<MadCap:xref\b([^>]*)\/>/gi;
const XREF_BLOCK_REGEX = /<MadCap:xref\b([^>]*)>([\s\S]*?)<\/MadCap:xref>/gi;
const KEYWORD_TAG_REGEX = /<MadCap:keyword\b[^>]*\/>|<MadCap:keyword\b[^>]*>[\s\S]*?<\/MadCap:keyword>/gi;
const ANNOTATION_BLOCK_REGEX = /<MadCap:annotation\b[^>]*>([\s\S]*?)<\/MadCap:annotation>/gi;
const ANNOTATION_SELF_CLOSING_REGEX = /<MadCap:annotation\b[^>]*\/>/gi;
// Related topics: a <MadCap:relatedTopics> container with one or more
// self-closing <MadCap:relatedTopic href="…" /> children. Rendered as a
// small navigation aside in the preview so authors can see the references.
const RELATED_TOPICS_REGEX = /<MadCap:relatedTopics\b[^>]*>([\s\S]*?)<\/MadCap:relatedTopics>/gi;
const RELATED_TOPICS_SELF_CLOSING_REGEX = /<MadCap:relatedTopics\b[^>]*\/>/gi;
const RELATED_TOPIC_ITEM_REGEX = /<MadCap:relatedTopic\b([^>]*)\/>/gi;
// <MadCap:conditionalText> is the inline counterpart to
// <MadCap:conditionalBlock>: a transparent wrapper around a span of inline
// text that's gated by a `MadCap:conditions=` attribute. The condition
// renderer in `applyConditions` already handles the gating (hiding the whole
// element when the active target excludes its conditions, or stripping the
// `MadCap:conditions=` attribute when it includes them). After that pass
// runs, any surviving wrapper has done its job and we can unwrap it so the
// inner content flows back into the surrounding paragraph naturally.
const CONDITIONAL_TEXT_REGEX = /<MadCap:conditionalText\b[^>]*>([\s\S]*?)<\/MadCap:conditionalText>/gi;
const CONDITIONAL_TEXT_SELF_CLOSING_REGEX = /<MadCap:conditionalText\b[^>]*\/>/gi;
// <MadCap:footnote> is an inline footnote with the footnote text as its
// children. We render it as a superscript dagger that carries the inner
// text as a hover tooltip — we don't have a numbering pass.
const FOOTNOTE_REGEX = /<MadCap:footnote\b[^>]*>([\s\S]*?)<\/MadCap:footnote>/gi;
const FOOTNOTE_SELF_CLOSING_REGEX = /<MadCap:footnote\b[^>]*\/>/gi;
// <MadCap:concept> is a topic-classification anchor (like a tag) with no
// visible content. Drop it.
const CONCEPT_REGEX = /<MadCap:concept\b[^>]*>([\s\S]*?)<\/MadCap:concept>/gi;
const CONCEPT_SELF_CLOSING_REGEX = /<MadCap:concept\b[^>]*\/>/gi;
// <MadCap:popup> is a tooltip-on-click element with a hotspot and a body.
// Same structural shape as <MadCap:dropDown>, so we render it as a
// <details>/<summary> pair too.
const POPUP_REGEX = /<MadCap:popup\b([^>]*)>([\s\S]*?)<\/MadCap:popup>/gi;
const POPUP_HEAD_REGEX = /<MadCap:popupHead\b[^>]*>([\s\S]*?)<\/MadCap:popupHead>/gi;
const POPUP_BODY_REGEX = /<MadCap:popupBody\b[^>]*>([\s\S]*?)<\/MadCap:popupBody>/gi;
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
    let transformed = replaceDropDowns(htmlContent);
    transformed = replacePopups(transformed);
    return transformed;
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

const relatedTopicsTransformHandler: TransformHandler = {
  id: "related-topics",
  run(htmlContent) {
    return replaceRelatedTopics(htmlContent);
  }
};

/**
 * Silently drops authoring/metadata tags whose content (or absence of
 * content) should never appear in the rendered preview. Runs before the
 * unsupported-tag fallback so these don't pollute the warning list.
 *
 * Also unwraps `<MadCap:conditionalText>` here because by the time this
 * handler runs the condition renderer has already either hidden the whole
 * element (if the active target excludes its conditions) or stripped its
 * `MadCap:conditions=` attribute (if it includes them). The wrapper itself
 * is then transparent — its job is done and we want its inner content to
 * flow back into the surrounding paragraph as if the wrapper had never
 * been there.
 *
 * Three more tags handled here for completeness:
 *   - <MadCap:concept> — topic-classification anchor with no visible
 *     content. Drop entirely.
 *   - <MadCap:footnote> — inline footnote with the footnote text as its
 *     children. Render as a small superscript dagger that carries the
 *     inner text as a hover tooltip. We don't have Flare's footnote-
 *     numbering pass so the marker is the same for every footnote in the
 *     topic; that's a known limitation but lets the rendered topic stay
 *     readable instead of dropping the footnote text entirely.
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
    transformed = transformed.replace(
      CONDITIONAL_TEXT_REGEX,
      (_full, body: string) => body
    );
    transformed = transformed.replace(CONDITIONAL_TEXT_SELF_CLOSING_REGEX, "");
    transformed = transformed.replace(CONCEPT_REGEX, "");
    transformed = transformed.replace(CONCEPT_SELF_CLOSING_REGEX, "");
    transformed = transformed.replace(FOOTNOTE_REGEX, (_full, body: string) => {
      const footnoteText = stripTags(body).trim();
      const tooltip = footnoteText.length > 0 ? footnoteText : "footnote";
      return `<sup class="madcap-footnote" title="${escapeHtml(tooltip)}">†</sup>`;
    });
    transformed = transformed.replace(
      FOOTNOTE_SELF_CLOSING_REGEX,
      `<sup class="madcap-footnote" title="footnote">†</sup>`
    );
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
  relatedTopicsTransformHandler,
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

    // Unwrap dropDownHead / dropDownBody wrappers but preserve their inner
    // content. They're structural — Flare uses them as XML grouping inside
    // the dropDown — and would otherwise survive into the rendered <details>
    // body where the unsupported-tag handler would warn on them.
    body = body.replace(DROPDOWN_HEAD_REGEX, (_match, inner: string) => inner);
    body = body.replace(DROPDOWN_BODY_REGEX, (_match, inner: string) => inner);

    const title = declaredTitle?.trim() || hotspotTitle || (tagName === "dropDown" ? "Details" : "Expand");
    return `<details class="madcap-${tagName.toLowerCase()}"><summary>${escapeHtml(title)}</summary><div class="madcap-expandable-content">${body}</div></details>`;
  });
}

/**
 * Renders <MadCap:popup> as a <details> element. Structurally identical to
 * dropDown: a wrapper with optional <MadCap:popupHead> (the trigger text)
 * and <MadCap:popupBody> (the revealed content). In Flare's published
 * output a popup is a click-to-open tooltip; we render it as a disclosure
 * widget for the editing-pass preview because the semantics are the same:
 * "trigger reveals content".
 */
function replacePopups(htmlContent: string): string {
  return htmlContent.replace(POPUP_REGEX, (_full, _attributes: string, content: string) => {
    let body = content;
    let title = "";

    // popupHead carries the trigger text. Extract it before unwrapping the
    // wrapper so we can use it as the <summary>.
    const headMatch = POPUP_HEAD_REGEX.exec(content);
    POPUP_HEAD_REGEX.lastIndex = 0;
    if (headMatch) {
      title = stripTags(headMatch[1]).trim();
      body = body.replace(POPUP_HEAD_REGEX, "");
    }

    // popupBody is a transparent wrapper around the revealed content.
    body = body.replace(POPUP_BODY_REGEX, (_match, inner: string) => inner);

    if (!title) {
      title = "Show details";
    }

    return `<details class="madcap-popup"><summary>${escapeHtml(title)}</summary><div class="madcap-popup-body">${body}</div></details>`;
  });
}

/**
 * Renders `<MadCap:relatedTopics>` blocks as a small navigation aside.
 *
 * Each `<MadCap:relatedTopic href="…" />` child becomes a list item with the
 * basename of its href as the link text. We don't try to look up the target
 * topic's H1 here (that would require an async pass and the topic index) —
 * the basename is good enough for an editing-pass preview, and authors who
 * want richer link text can hover the rendered link to see the full href in
 * the title attribute.
 *
 * Self-closing `<MadCap:relatedTopics />` (no children) is silently dropped.
 */
function replaceRelatedTopics(htmlContent: string): string {
  let transformed = htmlContent.replace(RELATED_TOPICS_REGEX, (_full, body: string) => {
    const items: string[] = [];
    RELATED_TOPIC_ITEM_REGEX.lastIndex = 0;
    let itemMatch = RELATED_TOPIC_ITEM_REGEX.exec(body);
    while (itemMatch) {
      const attrs = itemMatch[1] ?? "";
      const href = readAttribute(attrs, ["href", "src"]) ?? "";
      if (href.length > 0) {
        const display = relatedTopicLinkText(href);
        const safeHref = escapeHtml(href);
        items.push(
          `<li><a class="madcap-related-topic" href="#" data-flare-href="${safeHref}" title="${safeHref}">${escapeHtml(display)}</a></li>`
        );
      }
      itemMatch = RELATED_TOPIC_ITEM_REGEX.exec(body);
    }
    if (items.length === 0) {
      return "";
    }
    return `<aside class="madcap-related-topics"><h3 class="madcap-related-topics-header">Related topics</h3><ul>${items.join("")}</ul></aside>`;
  });

  // Self-closing variant: no children, nothing to render.
  transformed = transformed.replace(RELATED_TOPICS_SELF_CLOSING_REGEX, "");
  return transformed;
}

function relatedTopicLinkText(href: string): string {
  // Strip a trailing fragment / query string and use the basename of what
  // remains. Falls back to the full href if the basename is empty.
  const withoutHash = href.replace(/[#?].*$/, "");
  const lastSlash = Math.max(withoutHash.lastIndexOf("/"), withoutHash.lastIndexOf("\\"));
  const basename = withoutHash.slice(lastSlash + 1);
  return basename.length > 0 ? basename : href;
}

async function replaceSnippets(
  htmlContent: string,
  context: TransformContext,
  warnings: string[]
): Promise<string> {
  // Top-level pass: snippets resolve relative to the current topic, no
  // visited set (the topic is the entry point and isn't a snippet itself).
  return expandSnippetsIn(htmlContent, context, warnings, undefined, new Set<string>());
}

/**
 * Recursive snippet expansion. Used for both the top-level topic body and
 * for any snippet body loaded via {@link loadSnippet} that itself contains
 * `<MadCap:snippet>` references. The `baseDir` argument overrides the path
 * resolver's default (`context.currentDocument`) so a nested snippet's
 * relative path is resolved against the *outer snippet's* directory rather
 * than the topic's. The `visited` set carries the absolute paths of every
 * snippet currently being expanded so a cycle doesn't infinite loop.
 */
async function expandSnippetsIn(
  htmlContent: string,
  context: TransformContext,
  warnings: string[],
  baseDir: string | undefined,
  visited: Set<string>
): Promise<string> {
  let transformed = htmlContent;

  transformed = await replaceMatchesAsync(
    transformed,
    SNIPPET_SELF_CLOSING_REGEX,
    async (_full: string, _tagName: string, attributes: string) => {
      const src = readAttribute(attributes, ["src", "source"]);
      return loadSnippet(src, context, warnings, baseDir, visited);
    }
  );

  transformed = await replaceMatchesAsync(
    transformed,
    SNIPPET_BLOCK_REGEX,
    async (_full: string, _tagName: string, attributes: string) => {
      const src = readAttribute(attributes, ["src", "source"]);
      return loadSnippet(src, context, warnings, baseDir, visited);
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

const MAX_SNIPPET_DEPTH = 32;

async function loadSnippet(
  snippetSource: string | undefined,
  context: TransformContext,
  warnings: string[],
  baseDir: string | undefined,
  visited: Set<string>
): Promise<string> {
  if (!snippetSource) {
    warnings.push("Snippet tag missing src/source attribute.");
    return "<div class=\"madcap-missing-snippet\">[Snippet missing source]</div>";
  }

  const resolvedPath = resolveSnippetPath(snippetSource, context, baseDir);
  if (!resolvedPath) {
    warnings.push(`Snippet path could not be resolved: ${snippetSource}`);
    return `<div class=\"madcap-missing-snippet\">[Snippet not found: ${escapeHtml(snippetSource)}]</div>`;
  }

  // Cycle detection. If a snippet eventually references itself (or enters
  // a chain that loops back to a snippet currently being expanded) we hard-
  // stop here with a warning instead of stack-overflowing. Also defense in
  // depth: cap recursion at MAX_SNIPPET_DEPTH so a deeply (legitimately)
  // nested snippet chain can't run away either.
  const normalizedPath = path.normalize(resolvedPath);
  if (visited.has(normalizedPath)) {
    warnings.push(`Circular snippet reference detected: ${snippetSource}`);
    return `<div class=\"madcap-missing-snippet\">[Circular snippet: ${escapeHtml(snippetSource)}]</div>`;
  }
  if (visited.size >= MAX_SNIPPET_DEPTH) {
    warnings.push(`Snippet nesting depth exceeded ${MAX_SNIPPET_DEPTH}: ${snippetSource}`);
    return `<div class=\"madcap-missing-snippet\">[Snippet too deeply nested: ${escapeHtml(snippetSource)}]</div>`;
  }

  let raw: string;
  try {
    const bytes = await fs.readFile(resolvedPath);
    raw = Buffer.from(bytes).toString("utf8");
  } catch {
    warnings.push(`Snippet file missing: ${resolvedPath}`);
    return `<div class=\"madcap-missing-snippet\">[Snippet not found: ${escapeHtml(snippetSource)}]</div>`;
  }

  // Substitute variables inside the snippet body before recursing. The
  // variable handler in the top-level pipeline runs once on the topic
  // before the snippet handler, so any <MadCap:variable> references
  // appearing inside loaded snippet content never get resolved by the
  // top-level pass and would otherwise reach the unsupported-tag fallback.
  // (xref and conditionalText inside snippets are still not re-processed —
  // see the known limitation above.)
  let processed = replaceMadcapVariables(raw, context.variables, warnings);

  // Recursively expand any nested <MadCap:snippet> / <MadCap:snippetBlock> /
  // <MadCap:snippetText> references inside this snippet body. The recursion
  // uses *this* snippet's directory as the base path so nested relative
  // references resolve correctly (e.g. "../sn-tip.flsnp" inside a snippet
  // resolves relative to the snippet's folder, not the topic's). The
  // visited set is forked per-branch so two snippets can both legitimately
  // reference the same shared sub-snippet without false-positive cycle
  // warnings.
  const nextVisited = new Set(visited);
  nextVisited.add(normalizedPath);
  const nextBaseDir = path.dirname(resolvedPath);
  processed = await expandSnippetsIn(processed, context, warnings, nextBaseDir, nextVisited);

  return processed;
}

/**
 * Resolves a snippet `src` attribute to an absolute filesystem path.
 *
 *   - Absolute paths are returned as-is.
 *   - Relative paths are tried first against `baseDir` (the directory of
 *     the *containing* file — either the current topic for top-level
 *     snippets, or the parent snippet's directory for nested snippets) and
 *     then against the project root.
 *   - When `baseDir` is undefined (top-level call), it defaults to the
 *     directory of the current topic.
 */
function resolveSnippetPath(
  source: string,
  context: TransformContext,
  baseDir: string | undefined
): string | undefined {
  const normalized = source.replace(/\\/g, "/");

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  const effectiveBase = baseDir ?? path.dirname(context.currentDocument.fsPath);
  const candidateFromBase = path.resolve(effectiveBase, normalized);
  if (pathExists(candidateFromBase)) {
    return candidateFromBase;
  }

  if (context.projectContext) {
    const candidateFromProject = path.resolve(context.projectContext.projectRoot.fsPath, normalized);
    if (pathExists(candidateFromProject)) {
      return candidateFromProject;
    }
  }

  return candidateFromBase;
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
