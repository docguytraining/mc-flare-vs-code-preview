import * as vscode from "vscode";

/**
 * Attribute-name completion for `MadCap:conditions` and
 * `MadCap:conditionTagExpression`. Surfaces these names while the cursor is
 * inside an opening tag (after `<tagName ` and before the closing `>`), so
 * authors can scaffold the attribute without typing the full prefix. The
 * inserted snippet drops the cursor between the quotes and immediately
 * re-triggers IntelliSense so the existing
 * {@link ConditionCompletionProvider} can offer tag values.
 *
 * Companion to the value-completion provider, which only fires *after* the
 * author has already typed `MadCap:conditions="`. This provider is the entry
 * point that gets them there.
 */
export class ConditionAttributeCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    if (!cursorIsInOpeningTagAttributeArea(document, position)) {
      return undefined;
    }
    return [
      buildItem(
        "MadCap:conditions",
        'Hide this element when the active build target excludes the listed tag(s).'
      ),
      buildItem(
        "MadCap:conditionTagExpression",
        'Filter a snippet include by a Flare condition expression (e.g. `include[Default.Public]`).'
      )
    ];
  }
}

function buildItem(name: string, description: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
  item.detail = `Flare attribute — ${name}`;
  item.documentation = new vscode.MarkdownString(description);
  item.insertText = new vscode.SnippetString(`${name}="$1"$0`);
  item.filterText = name;
  // Re-trigger IntelliSense once the cursor lands between the quotes so the
  // companion value-completion provider fires immediately.
  item.command = {
    command: "editor.action.triggerSuggest",
    title: "Re-trigger completions"
  };
  return item;
}

/**
 * Returns true when the cursor sits inside an opening tag's attribute area —
 * i.e. there is an unclosed `<` on the current line whose tag name has
 * already been typed and we are now in whitespace where attributes go.
 */
function cursorIsInOpeningTagAttributeArea(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  const lastOpen = linePrefix.lastIndexOf("<");
  const lastClose = linePrefix.lastIndexOf(">");
  if (lastOpen <= lastClose) {
    return false;
  }
  // Must be past the tag name, which means we've already typed at least one
  // whitespace character after `<tagName`. Otherwise we'd be polluting the
  // tag-name completion path.
  const tagFragment = linePrefix.slice(lastOpen + 1);
  if (!/^[A-Za-z][\w:.-]*\s/.test(tagFragment)) {
    return false;
  }
  // Don't fire while the cursor is inside an existing attribute value.
  // Count quotes that follow the last `<`; an odd count means we're inside
  // a string.
  const quoteCount = (tagFragment.match(/["']/g) ?? []).length;
  return quoteCount % 2 === 0;
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
