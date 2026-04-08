import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { SnippetIndex } from "../flare/snippetIndex";
import { expandRangeOverTrailingCloseBrackets } from "./xrefBracketCompletionProvider";

const TRIGGER = "{{";

/**
 * Trigger-character completion for snippet inserts. Anywhere in topic prose,
 * typing `{{` opens a project-wide snippet picker. On accept, the `{{`
 * characters are erased and replaced with a complete `<MadCap:snippetBlock>`
 * tag pointing at the chosen snippet.
 *
 * Sibling to {@link XrefBracketCompletionProvider} (which uses `[[` for
 * cross-references). The two are intentionally similar so authors only have
 * to learn one shape.
 */
export class SnippetBracketCompletionProvider implements vscode.CompletionItemProvider {
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
    if (position.character < 2) {
      return undefined;
    }
    const prefixRange = new vscode.Range(
      new vscode.Position(position.line, position.character - 2),
      position
    );
    if (document.getText(prefixRange) !== TRIGGER) {
      return undefined;
    }
    if (cursorIsInsideTag(document, position)) {
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
    // Erase the `{{` AND any auto-inserted `}}` (or partial `}`) that VS
    // Code's bracket auto-close left immediately after the cursor.
    const replaceRange = expandRangeOverTrailingCloseBrackets(document, position, prefixRange);
    return entries.map((entry) => {
      const relativeFromDocument = path
        .relative(documentDir, entry.absPath)
        .replace(/\\/g, "/");
      const safeSrc = escapeAttribute(relativeFromDocument);
      const item = new vscode.CompletionItem(
        { label: entry.name, description: entry.relPath },
        vscode.CompletionItemKind.Snippet
      );
      item.detail = `Insert <MadCap:snippetBlock src="${relativeFromDocument}" />`;
      item.documentation = entry.preview;
      item.filterText = `{{${entry.name} ${entry.relPath}`;
      item.sortText = entry.relPath;
      item.insertText = new vscode.SnippetString(
        `<MadCap:snippetBlock src="${safeSrc}" />$0`
      );
      item.range = replaceRange;
      return item;
    });
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function cursorIsInsideTag(document: vscode.TextDocument, position: vscode.Position): boolean {
  const lineText = document.lineAt(position.line).text.slice(0, position.character);
  const lastOpen = lineText.lastIndexOf("<");
  const lastClose = lineText.lastIndexOf(">");
  return lastOpen > lastClose;
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
