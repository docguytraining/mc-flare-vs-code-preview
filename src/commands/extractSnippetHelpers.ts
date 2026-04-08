import * as path from "node:path";

/**
 * Pure helpers for the "Extract selection as snippet" refactor. Kept free of
 * `vscode` imports so they can be exercised by node-only unit tests.
 */

/**
 * Reference attributes whose values are local file paths inside a Flare
 * project. Mirrors the list used by the cross-project rename scanner — any
 * attribute that the rename scanner picks up needs to be rewritten by the
 * snippet extractor too, otherwise nested xrefs / images / snippet refs in
 * the lifted selection point at the *original* topic's directory and break
 * the moment the new `.flsnp` file lives anywhere else.
 *
 * Case-insensitive match: real Flare project files use `Link` and `File`
 * with capitalized first letters in TOCs and alias entries, while topic
 * markup uses lowercase `href` and `src`.
 */
const REFERENCE_ATTRIBUTE_REGEX =
  /\b(href|src|source|xlink:href|MadCap:Link|Link|File|Topic)\s*=\s*(["'])([^"']*)\2/gi;

/** Schemes (and protocol-relative URIs) that the rewriter must leave alone. */
const EXTERNAL_SCHEME_REGEX =
  /^(?:https?|mailto|tel|ftp|data|javascript|vscode-webview):/i;

/**
 * Walks the lifted XHTML and rewrites every local reference attribute so
 * its value stays valid from the new snippet file's location. Each value
 * is resolved relative to `fromTopicPath` (where it currently makes
 * sense) and re-emitted relative to `toSnippetPath` (where the snippet
 * will live after the extraction edit).
 *
 * The rewriter handles:
 *   - Sibling-relative refs (`../images/foo.png`) — re-anchored to the new
 *     snippet directory.
 *   - Project-root-relative refs (`/Content/Topics/Foo.htm`) — left
 *     untouched, since `/`-prefixed Flare paths are always rooted at the
 *     project, not at the source topic.
 *   - Bare anchor refs (`#bookmark`) — left untouched.
 *   - External / scheme-prefixed URLs (`http(s)://`, `mailto:`, etc.) —
 *     left untouched. The scanner never makes network requests.
 *   - Empty values — left untouched.
 *
 * `#fragment` suffixes on file paths are preserved verbatim.
 *
 * Exported and `vscode`-free so it can be unit-tested without launching
 * an extension host.
 */
export function rewriteLocalReferences(
  innerXhtml: string,
  fromTopicPath: string,
  toSnippetPath: string
): string {
  const fromDir = path.dirname(fromTopicPath);
  const toDir = path.dirname(toSnippetPath);
  // Identical source and destination directories means every relative ref
  // already lines up — no rewrite needed. Project-root refs would also be
  // a no-op, so we can short-circuit.
  if (path.normalize(fromDir) === path.normalize(toDir)) {
    return innerXhtml;
  }

  return innerXhtml.replace(
    REFERENCE_ATTRIBUTE_REGEX,
    (fullMatch, attrName: string, quote: string, value: string) => {
      const rewritten = rewriteOneReferenceValue(value, fromDir, toDir);
      if (rewritten === value) {
        return fullMatch;
      }
      return `${attrName}=${quote}${rewritten}${quote}`;
    }
  );
}

/**
 * Pure helper exposed for unit tests. Returns the rewritten value for a
 * single attribute value, or the input unchanged if no rewrite applies.
 */
export function rewriteOneReferenceValue(
  value: string,
  fromDir: string,
  toDir: string
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  if (EXTERNAL_SCHEME_REGEX.test(trimmed) || trimmed.startsWith("//")) {
    return value;
  }
  if (trimmed.startsWith("#")) {
    return value;
  }
  // Flare's `/`-prefixed paths are project-root-relative — they don't
  // depend on where the file containing them lives, so they survive a
  // move without rewriting. Same for Windows drive-letter absolutes
  // (rare, but possible in legacy projects).
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return value;
  }

  const [pathPart, anchorPart] = splitHash(trimmed);
  if (pathPart.length === 0) {
    return value;
  }

  const absolute = path.resolve(fromDir, pathPart.replace(/\\/g, "/"));
  const rewritten = path.relative(toDir, absolute).replace(/\\/g, "/");
  // `path.relative` returns "" when the two paths point at the same file
  // (rare, but possible if the lifted reference targets the snippet
  // itself). Fall back to the bare basename in that case.
  const rewrittenPath =
    rewritten.length > 0 ? rewritten : path.basename(absolute);
  return anchorPart === undefined ? rewrittenPath : `${rewrittenPath}#${anchorPart}`;
}

function splitHash(href: string): [string, string | undefined] {
  const index = href.indexOf("#");
  if (index < 0) {
    return [href, undefined];
  }
  return [href.slice(0, index), href.slice(index + 1)];
}

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
