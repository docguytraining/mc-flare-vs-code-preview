import * as path from "node:path";

export interface FileRename {
  oldPath: string;
  newPath: string;
}

/**
 * Resolves a reference value (`href`, `src`, etc.) to an absolute filesystem
 * path. A leading `/` is treated as project-root-relative the way Flare uses
 * it, **not** as filesystem-absolute. Returns undefined for empty values.
 */
export function resolveReferencePath(
  pathPart: string,
  fileDir: string,
  projectRoot: string
): string | undefined {
  const normalized = pathPart.replace(/\\/g, "/");
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.startsWith("/")) {
    return path.normalize(path.join(projectRoot, normalized.slice(1)));
  }
  return path.normalize(path.resolve(fileDir, normalized));
}

/**
 * Rewrites a reference value so it points at the rename's new path while
 * preserving the original style. Project-root-relative refs (`/Content/foo`)
 * stay project-root-relative; sibling-relative refs (`../foo.htm`) stay
 * relative.
 */
export function rewriteReferencePath(
  pathPart: string,
  fileDir: string,
  rename: FileRename
): string {
  const normalized = pathPart.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    const newRelative = path.relative(path.dirname(fileDir), rename.newPath);
    if (newRelative.startsWith("..")) {
      return `/${path.basename(rename.newPath)}`;
    }
    return `/${newRelative.replace(/\\/g, "/")}`;
  }
  const relative = path.relative(fileDir, rename.newPath).replace(/\\/g, "/");
  return relative.length > 0 ? relative : path.basename(rename.newPath);
}

/** Splits an `href` value into its `[path, anchor?]` halves. */
export function splitHash(href: string): [string, string | undefined] {
  const index = href.indexOf("#");
  if (index < 0) {
    return [href, undefined];
  }
  return [href.slice(0, index), href.slice(index + 1)];
}

/** Returns true if the value is an external URL or scheme-prefixed link. */
export function isExternal(href: string): boolean {
  return (
    /^(https?|mailto|tel|ftp|data|javascript|vscode-webview):/i.test(href) ||
    href.startsWith("//")
  );
}

/** Translates an offset in `text` into a 0-based `{ line, column }`. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charAt(i) === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart };
}
