import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { ConditionTagIndex } from "../flare/conditionTagIndex";

const CONDITION_ATTR_REGEX =
  /<[A-Za-z][^>]*\bMadCap:(?:conditions|conditionTagExpression)\s*=\s*(["'])([^"']*)$/i;

/**
 * Completion provider for `MadCap:conditions=` and
 * `MadCap:conditionTagExpression=` attribute values. Triggered while the
 * cursor sits inside the attribute string; lists every known qualified
 * `<set>.<tag>` from the project's `.flcts` files.
 */
export class ConditionCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly conditionTagIndex: ConditionTagIndex
  ) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const upToCursor = document.getText(
      new vscode.Range(new vscode.Position(Math.max(0, position.line - 4), 0), position)
    );
    if (!CONDITION_ATTR_REGEX.test(upToCursor)) {
      return undefined;
    }

    const projectContext = await this.projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      return undefined;
    }

    const tags = await this.conditionTagIndex.getEntries(projectContext);
    if (tags.length === 0) {
      return undefined;
    }

    // Determine the partial token immediately before the cursor so VS Code
    // can replace it cleanly when the user picks a completion. Tokens end
    // at commas, semicolons, opening/closing brackets, whitespace, or quotes.
    let tokenStart = linePrefix.length;
    while (tokenStart > 0) {
      const ch = linePrefix.charAt(tokenStart - 1);
      if (ch === "," || ch === ";" || ch === "[" || ch === "(" || ch === " " || ch === '"' || ch === "'") {
        break;
      }
      tokenStart -= 1;
    }
    const replaceRange = new vscode.Range(
      new vscode.Position(position.line, tokenStart),
      position
    );

    return tags.map((tag) => {
      // Use CompletionItemKind.Color so VS Code paints a small color swatch
      // next to the completion. The swatch is read from `documentation`, which
      // must be a hex string for VS Code's renderer to pick it up.
      const hasColor = typeof tag.color === "string" && /^#[0-9a-f]{3,8}$/i.test(tag.color);
      const item = new vscode.CompletionItem(
        tag.qualifiedName,
        hasColor ? vscode.CompletionItemKind.Color : vscode.CompletionItemKind.EnumMember
      );
      item.detail = tag.description ?? `Defined in ${tag.setName}.flcts`;
      if (hasColor) {
        // VS Code reads the hex value out of `documentation` (must be a string)
        // when the kind is Color. We surface the rich Markdown via `detail`
        // since `documentation` is now reserved for the swatch.
        item.documentation = tag.color as string;
      } else {
        const documentation = new vscode.MarkdownString();
        documentation.appendMarkdown(`**${tag.qualifiedName}**`);
        if (tag.description) {
          documentation.appendMarkdown(`\n\n${tag.description}`);
        }
        if (tag.color) {
          documentation.appendMarkdown(`\n\nColor: \`${tag.color}\``);
        }
        item.documentation = documentation;
      }
      item.insertText = tag.qualifiedName;
      item.filterText = tag.qualifiedName;
      item.range = replaceRange;
      // Re-trigger IntelliSense after accept so the author can chain a comma
      // and immediately pick the next tag without retyping anything.
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Re-trigger completions"
      };
      return item;
    });
  }
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
