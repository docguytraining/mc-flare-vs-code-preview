import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { extractBookmarks } from "../flare/topicIndex";

const DIAGNOSTIC_SOURCE = "flare";

type LinkKind = "xref" | "anchor" | "image" | "stylesheet" | "snippet";

interface LinkReference {
  kind: LinkKind;
  rawHref: string;
  valueStart: number;
  valueLength: number;
}

const REFERENCE_PATTERNS: Array<{ kind: LinkKind; regex: RegExp }> = [
  {
    kind: "xref",
    regex: /<MadCap:xref\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1/gi
  },
  {
    kind: "anchor",
    regex: /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1/gi
  },
  {
    kind: "image",
    regex: /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*)\1/gi
  },
  {
    kind: "stylesheet",
    regex: /<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*(["'])([^"']*)\1/gi
  },
  {
    kind: "snippet",
    regex: /<MadCap:(?:snippet|snippetBlock)\b[^>]*\b(?:src|source)\s*=\s*(["'])([^"']*)\1/gi
  }
];

/**
 * Scans a Flare topic for local link references and emits Problems-panel
 * diagnostics for broken files, missing anchors, and case-sensitivity drift.
 * External URLs (http(s):, mailto:, tel:, data:) are deliberately skipped —
 * no network I/O ever happens.
 */
export class LinkValidator {
  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly projectResolver: FlareProjectResolver
  ) {}

  public async validate(document: vscode.TextDocument): Promise<void> {
    if (!isFlareTopic(document)) {
      return;
    }

    const enabled = vscode.workspace
      .getConfiguration("flarePreview")
      .get<boolean>("validateLinks", true);
    if (!enabled) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const projectContext = await this.projectResolver.resolveForFile(document.uri).catch(() => undefined);
    const projectRoot = projectContext?.projectRoot.fsPath;

    const text = document.getText();
    const references = collectReferences(text);
    if (references.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const entries: vscode.Diagnostic[] = [];
    for (const reference of references) {
      const diagnostic = await this.validateReference(document, reference, projectRoot);
      if (diagnostic) {
        entries.push(diagnostic);
      }
    }

    if (entries.length === 0) {
      this.diagnostics.delete(document.uri);
    } else {
      this.diagnostics.set(document.uri, entries);
    }
  }

  public clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
  }

  private async validateReference(
    document: vscode.TextDocument,
    reference: LinkReference,
    projectRoot: string | undefined
  ): Promise<vscode.Diagnostic | undefined> {
    const href = reference.rawHref.trim();
    if (href.length === 0) {
      return undefined;
    }
    if (isExternal(href)) {
      return undefined;
    }
    if (href.startsWith("#")) {
      // Same-document anchor — resolve against the current document.
      return validateAnchor(document, reference, href.slice(1), document.getText());
    }

    const documentDir = path.dirname(document.uri.fsPath);
    const [pathPart, anchorPart] = splitHash(href);

    const candidates = [path.resolve(documentDir, pathPart)];
    if (projectRoot) {
      candidates.push(path.resolve(projectRoot, pathPart));
    }

    let resolved: string | undefined;
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        resolved = candidate;
        break;
      }
    }

    if (!resolved) {
      return makeDiagnostic(
        document,
        reference,
        vscode.DiagnosticSeverity.Error,
        `${describeKind(reference.kind)} target not found: ${pathPart}`,
        "flare.link-missing",
        `Checked ${candidates.map((candidate) => path.relative(projectRoot ?? documentDir, candidate) || candidate).join(", ")}.`
      );
    }

    // Case drift: ensure the referenced case matches the on-disk case. Only
    // reported as Information since the file is found by the OS.
    const caseDriftHint = await detectCaseDrift(resolved, pathPart);
    let caseDriftDiagnostic: vscode.Diagnostic | undefined;
    if (caseDriftHint) {
      caseDriftDiagnostic = makeDiagnostic(
        document,
        reference,
        vscode.DiagnosticSeverity.Information,
        `Reference casing '${pathPart}' differs from on-disk casing '${caseDriftHint}'.`,
        "flare.link-case-drift",
        "Case-sensitive file systems (Linux, some CI runners) will fail to resolve this link."
      );
    }

    if (anchorPart) {
      const targetText = await readTextOrUndefined(resolved);
      if (targetText === undefined) {
        return makeDiagnostic(
          document,
          reference,
          vscode.DiagnosticSeverity.Warning,
          `Could not read target topic to verify anchor '#${anchorPart}'.`,
          "flare.anchor-unreadable"
        );
      }
      const anchorDiagnostic = validateAnchor(document, reference, anchorPart, targetText);
      if (anchorDiagnostic) {
        return anchorDiagnostic;
      }
    }

    return caseDriftDiagnostic;
  }
}

function collectReferences(text: string): LinkReference[] {
  const references: LinkReference[] = [];
  for (const { kind, regex } of REFERENCE_PATTERNS) {
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match) {
      const fullEnd = match.index + match[0].length;
      // Match ends with the closing quote; the captured value occupies the
      // bytes immediately preceding it.
      const valueStart = fullEnd - 1 - match[2].length;
      references.push({
        kind,
        rawHref: match[2],
        valueStart,
        valueLength: match[2].length
      });
      match = regex.exec(text);
    }
  }
  return references;
}

function validateAnchor(
  document: vscode.TextDocument,
  reference: LinkReference,
  anchor: string,
  targetText: string
): vscode.Diagnostic | undefined {
  if (!anchor) {
    return undefined;
  }
  const bookmarks = extractBookmarks(targetText);
  if (bookmarks.some((bookmark) => bookmark.id === anchor)) {
    return undefined;
  }
  return makeDiagnostic(
    document,
    reference,
    vscode.DiagnosticSeverity.Warning,
    `Anchor '#${anchor}' was not found in the target topic.`,
    "flare.anchor-missing"
  );
}

function makeDiagnostic(
  document: vscode.TextDocument,
  reference: LinkReference,
  severity: vscode.DiagnosticSeverity,
  message: string,
  code: string,
  hint?: string
): vscode.Diagnostic {
  const range = new vscode.Range(
    document.positionAt(reference.valueStart),
    document.positionAt(reference.valueStart + reference.valueLength)
  );
  const diagnostic = new vscode.Diagnostic(range, hint ? `${message} ${hint}` : message, severity);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = code;
  return diagnostic;
}

function describeKind(kind: LinkKind): string {
  switch (kind) {
    case "xref":
      return "Cross-reference";
    case "anchor":
      return "Link";
    case "image":
      return "Image";
    case "stylesheet":
      return "Stylesheet";
    case "snippet":
      return "Snippet";
    default:
      return "Reference";
  }
}

function isExternal(href: string): boolean {
  return (
    /^(https?|mailto|tel|ftp|data|javascript|vscode-webview):/i.test(href) ||
    href.startsWith("//")
  );
}

function splitHash(href: string): [string, string | undefined] {
  const index = href.indexOf("#");
  if (index < 0) {
    return [href, undefined];
  }
  return [href.slice(0, index), href.slice(index + 1)];
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

async function detectCaseDrift(resolved: string, referenced: string): Promise<string | undefined> {
  const normalizedReferenced = referenced.replace(/\\/g, "/");
  const referencedBasename = path.basename(normalizedReferenced);
  const resolvedBasename = path.basename(resolved);
  if (referencedBasename === resolvedBasename) {
    return undefined;
  }
  // Only report when the basenames compare equal case-insensitively.
  if (referencedBasename.toLowerCase() !== resolvedBasename.toLowerCase()) {
    return undefined;
  }

  // Verify the actual on-disk spelling via the directory listing to avoid
  // reporting drift that only differs on Windows/macOS case-insensitive mounts.
  try {
    const directoryEntries: Dirent[] = await fs.readdir(path.dirname(resolved), { withFileTypes: true });
    const actual = directoryEntries.find((entry) => entry.name.toLowerCase() === resolvedBasename.toLowerCase());
    if (actual && actual.name !== referencedBasename) {
      return actual.name;
    }
  } catch {
    // Ignore.
  }
  return undefined;
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
