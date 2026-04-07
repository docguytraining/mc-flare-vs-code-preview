import * as vscode from "vscode";

const COMMAND = "flare.wrapSelectionAsXref";

/**
 * Code action that fires whenever the editor has a non-empty selection inside
 * a Flare topic. Choosing the action runs `flare.wrapSelectionAsXref`, which
 * opens the same project-wide topic picker as `flare.insertXref` and replaces
 * the selection with a `<MadCap:xref>` whose link text is the original
 * selection. The chosen topic determines the `href`.
 */
export class WrapSelectionAsXrefProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]
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
    if (selectionText.includes("<")) {
      // Don't offer the action when the selection already contains markup —
      // wrapping HTML inside an xref would corrupt the topic.
      return undefined;
    }

    const action = new vscode.CodeAction(
      "Convert to cross-reference…",
      vscode.CodeActionKind.RefactorRewrite
    );
    action.command = {
      command: COMMAND,
      title: "Convert to cross-reference…",
      arguments: [document.uri, range]
    };
    return [action];
  }
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
