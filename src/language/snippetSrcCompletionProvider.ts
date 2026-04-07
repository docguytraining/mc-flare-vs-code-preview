import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { SnippetIndex } from "../flare/snippetIndex";

const SRC_PREFIX_REGEX =
  /<MadCap:(?:snippet|snippetBlock|snippetText)\b[^>]*\bsrc\s*=\s*(["'])([^"']*)$/i;

/**
 * Completion provider for `src` attributes inside `<MadCap:snippet>`,
 * `<MadCap:snippetBlock>`, and `<MadCap:snippetText>` elements. Suggests
 * every `.flsnp` file in the project, sorted by path. Mirrors the existing
 * {@link XrefCompletionProvider} for `href` attributes.
 */
export class SnippetSrcCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly snippetIndex: SnippetIndex
  ) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    if (!SRC_PREFIX_REGEX.test(textBefore)) {
      return undefined;
    }
    const projectContext = await this.projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      return undefined;
    }
    const entries = await this.snippetIndex.getEntries(projectContext);
    if (entries.length === 0) {
      return undefined;
    }

    const documentDir = path.dirname(document.uri.fsPath);
    return entries.map((entry) => {
      const relativeFromDocument = path
        .relative(documentDir, entry.absPath)
        .replace(/\\/g, "/");
      const item = new vscode.CompletionItem(
        { label: entry.name, description: entry.relPath },
        vscode.CompletionItemKind.File
      );
      item.detail = relativeFromDocument;
      item.documentation = entry.preview;
      item.insertText = relativeFromDocument;
      item.filterText = `${entry.name} ${entry.relPath}`;
      item.sortText = entry.relPath;
      return item;
    });
  }
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
