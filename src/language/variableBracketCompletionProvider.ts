import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { VariableIndex } from "../flare/variableIndex";

const TRIGGER = "@@";

/**
 * Trigger-character completion for variable inserts. Anywhere in topic
 * prose, typing `@@` opens a project-wide variable picker. On accept, the
 * `@@` characters are erased and replaced with a complete
 * `<MadCap:variable name="Set.Name" />` reference.
 *
 * Sibling to {@link XrefBracketCompletionProvider} (`[[` for xrefs) and
 * {@link SnippetBracketCompletionProvider} (`{{` for snippets). The trio
 * was designed so authors only have to learn one shape: two identical
 * characters, and each one maps to one Flare authoring primitive.
 */
export class VariableBracketCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly variableIndex: VariableIndex
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
    const entries = await this.variableIndex.getEntries(projectContext);
    if (entries.length === 0) {
      return undefined;
    }

    const replaceRange = prefixRange;
    return entries.map((entry) => {
      const item = new vscode.CompletionItem(
        { label: entry.qualifiedName, description: entry.value },
        vscode.CompletionItemKind.Variable
      );
      item.detail = `Insert <MadCap:variable name="${entry.qualifiedName}" />`;
      item.documentation = new vscode.MarkdownString(
        `**${entry.qualifiedName}** = ${escapeMarkdown(entry.value)}`
      );
      item.filterText = `@@${entry.qualifiedName} ${entry.value}`;
      item.sortText = entry.qualifiedName;
      item.insertText = new vscode.SnippetString(
        `<MadCap:variable name="${escapeSnippet(entry.qualifiedName)}" />$0`
      );
      item.range = replaceRange;
      return item;
    });
  }
}

function cursorIsInsideTag(document: vscode.TextDocument, position: vscode.Position): boolean {
  const lineText = document.lineAt(position.line).text.slice(0, position.character);
  const lastOpen = lineText.lastIndexOf("<");
  const lastClose = lineText.lastIndexOf(">");
  return lastOpen > lastClose;
}

function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
