import * as path from "node:path";

/**
 * Pure helpers for the "Extract selection as snippet" refactor. Kept free of
 * `vscode` imports so they can be exercised by node-only unit tests.
 */

const RESERVED_NAMES = new Set(["con", "prn", "aux", "nul"]);

export interface SlugifyResult {
  ok: boolean;
  /** The normalized slug, or the original trimmed input on failure. */
  slug: string;
  /** Human-readable failure reason. Set when `ok === false`. */
  reason?: string;
}

/**
 * Normalizes a user-supplied snippet name into a safe filename. Strips
 * characters that aren't `[A-Za-z0-9-_]`, replaces whitespace with dashes,
 * collapses repeated dashes, and rejects empty / reserved names.
 */
export function slugifySnippetName(input: string): SlugifyResult {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, slug: "", reason: "Snippet name cannot be empty." };
  }
  const slug = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (slug.length === 0) {
    return {
      ok: false,
      slug,
      reason: "Snippet name must contain at least one letter or digit."
    };
  }
  if (RESERVED_NAMES.has(slug.toLowerCase())) {
    return { ok: false, slug, reason: `'${slug}' is a reserved filename.` };
  }
  return { ok: true, slug };
}

/**
 * Wraps the given XHTML body fragment in the canonical `.flsnp` file skeleton
 * that real Flare projects ship. The MadCap namespace is declared on the root
 * element so MadCap-prefixed children inside the snippet are well-formed XML.
 */
export function buildSnippetFileContent(innerXhtml: string): string {
  const body = innerXhtml.endsWith("\n") ? innerXhtml : `${innerXhtml}\n`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">',
    "  <head></head>",
    "  <body>",
    indent(body, "    "),
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

/**
 * Computes a sibling-relative `src` attribute pointing from `fromTopicPath`
 * to `toSnippetPath`. Returns forward-slash-separated paths regardless of
 * host OS so the resulting attribute is portable across Windows / macOS / Linux.
 */
export function computeSnippetSrcAttribute(
  fromTopicPath: string,
  toSnippetPath: string
): string {
  const relative = path
    .relative(path.dirname(fromTopicPath), toSnippetPath)
    .replace(/\\/g, "/");
  return relative.length > 0 ? relative : path.basename(toSnippetPath);
}

/**
 * Strips the longest common leading-whitespace prefix from every non-blank
 * line of the input. Lets the extracted snippet sit at the left margin of the
 * new `.flsnp` file regardless of how deeply indented it was in the topic.
 */
export function stripCommonIndent(text: string): string {
  const lines = text.split(/\r?\n/);
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0] : "";
    if (common === undefined) {
      common = indent;
      continue;
    }
    let i = 0;
    while (i < common.length && i < indent.length && common.charAt(i) === indent.charAt(i)) {
      i += 1;
    }
    common = common.slice(0, i);
    if (common.length === 0) {
      break;
    }
  }
  if (!common) {
    return text;
  }
  const safeCommon: string = common;
  return lines
    .map((line) => (line.startsWith(safeCommon) ? line.slice(safeCommon.length) : line))
    .join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join("\n")
    .replace(/[ \t]+$/g, "");
}
