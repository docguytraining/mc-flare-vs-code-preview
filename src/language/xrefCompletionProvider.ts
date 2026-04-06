import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { TopicIndex } from "../flare/topicIndex";

const HREF_PREFIX_REGEX = /\b(?:MadCap:xref|a)\b[^>]*\bhref\s*=\s*(["'])([^"']*)$/i;

/**
 * Completion provider for `href` attributes inside `<MadCap:xref>` and `<a>`
 * elements. Suggests project topics (ranked by H1 / relative path) and, once a
 * `#` is present, bookmark anchors scanned from the referenced topic.
 */
export class XrefCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly topicIndex: TopicIndex
  ) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const match = HREF_PREFIX_REGEX.exec(textBefore);
    if (!match) {
      return undefined;
    }

    const typedHref = match[2];
    const projectContext = await this.projectResolver.resolveForFile(document.uri);
    if (!projectContext) {
      return undefined;
    }

    const entries = await this.topicIndex.getEntries(projectContext);
    if (entries.length === 0) {
      return undefined;
    }

    const hashIndex = typedHref.indexOf("#");
    if (hashIndex >= 0) {
      const beforeHash = typedHref.slice(0, hashIndex);
      const targetAbsPath = resolveTargetPath(document.uri.fsPath, beforeHash, projectContext.projectRoot.fsPath);
      if (!targetAbsPath) {
        return undefined;
      }
      const bookmarks = await this.topicIndex.getBookmarks(vscode.Uri.file(targetAbsPath));
      return bookmarks.map((bookmark) => {
        const item = new vscode.CompletionItem(bookmark.id, vscode.CompletionItemKind.Reference);
        item.detail = `<${bookmark.element}>`;
        item.insertText = bookmark.id;
        return item;
      });
    }

    const documentDir = path.dirname(document.uri.fsPath);
    return entries.map((entry) => {
      const relativeFromDocument = path
        .relative(documentDir, entry.absPath)
        .replace(/\\/g, "/");
      const label = entry.h1 ?? path.basename(entry.relPath);
      const item = new vscode.CompletionItem(
        { label, description: entry.relPath },
        vscode.CompletionItemKind.File
      );
      item.detail = relativeFromDocument;
      item.insertText = relativeFromDocument;
      item.filterText = `${label} ${entry.relPath}`;
      return item;
    });
  }
}

function resolveTargetPath(
  fromDocumentPath: string,
  relativeHref: string,
  projectRoot: string
): string | undefined {
  const trimmed = relativeHref.trim();
  if (!trimmed) {
    return fromDocumentPath;
  }
  const fromDir = path.dirname(fromDocumentPath);
  const candidates = [
    path.resolve(fromDir, trimmed),
    path.resolve(projectRoot, trimmed)
  ];
  return candidates[0] ?? candidates[1];
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
