import * as vscode from "vscode";

const COMMAND = "flare.extractSelectionAsSnippet";

/**
 * Code action that surfaces an "Extract selection as snippet…" refactor on
 * any non-empty selection inside a Flare topic. Choosing the action runs
 * `flare.extractSelectionAsSnippet`, which prompts for a name + folder and
 * rewrites the selection into a `<MadCap:snippetBlock src="…"/>` reference.
 */
export class ExtractSnippetCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.RefactorExtract]
  };

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] | undefined {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    if (range.isEmpty) {
      return undefined;
    }
    const selectionText = document.getText(range);
    if (selectionText.trim().length === 0) {
      return undefined;
    }
    if (!hasBalancedTags(selectionText)) {
      return undefined;
    }

    const action = new vscode.CodeAction(
      "Extract selection as snippet…",
      vscode.CodeActionKind.RefactorExtract
    );
    action.command = {
      command: COMMAND,
      title: "Extract selection as snippet…",
      arguments: [document.uri, range]
    };
    return [action];
  }
}

/**
 * Cheap balance check: ensure the count of `<` matches the count of `>` and
 * that no opening tag is left unclosed. We aren't trying to be a real XML
 * parser — the goal is to refuse selections that obviously can't be lifted
 * out of their parent without breaking it (e.g. half a tag, or an opening
 * `<p>` whose `</p>` is outside the selection). Tags balanced by element
 * name are checked separately to catch the unmatched-tag case.
 */
export function hasBalancedTags(text: string): boolean {
  const opens = (text.match(/</g) ?? []).length;
  const closes = (text.match(/>/g) ?? []).length;
  if (opens !== closes) {
    return false;
  }
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z][\w:.-]*)\b[^>]*?(\/)?>/g;
  let match = tagRegex.exec(text);
  while (match) {
    const name = match[1].toLowerCase();
    const isSelfClosing = match[2] === "/" || isVoidElement(name);
    const isClosing = match[0].startsWith("</");
    if (isClosing) {
      if (stack.length === 0 || stack.pop() !== name) {
        return false;
      }
    } else if (!isSelfClosing) {
      stack.push(name);
    }
    match = tagRegex.exec(text);
  }
  return stack.length === 0;
}

function isVoidElement(name: string): boolean {
  return new Set([
    "br",
    "hr",
    "img",
    "input",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "source",
    "track",
    "wbr"
  ]).has(name);
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
