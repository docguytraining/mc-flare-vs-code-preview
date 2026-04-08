import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { VariableIndex, findVariablesByValue } from "../flare/variableIndex";

const COMMAND = "flare.replaceSelectionWithVariable";

/**
 * Code action surfaced on any non-empty selection inside a Flare topic
 * whose trimmed text exactly matches a known variable value. Choosing the
 * action runs {@link COMMAND}, which either replaces the selection with
 * `<MadCap:variable name="Set.Name" />` directly (if there is only one
 * matching variable) or pops a quick pick when multiple variables share
 * the same value.
 *
 * Distinct from the existing `VariableSuggestionEngine` (which surfaces
 * literal-matches as diagnostics + quick fixes, gated on
 * `flareToolkit.suggestVariableReplacements` and the dismissal lists).
 * This provider is manual-only: the author has to select the text and
 * invoke the lightbulb, so it bypasses both gates and the minimum-length
 * heuristic. Useful for short literals and for authors who keep the
 * automatic suggestions disabled.
 */
export class LiteralToVariableCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]
  };

  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly variableIndex: VariableIndex
  ) {}

  public async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): Promise<vscode.CodeAction[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    if (range.isEmpty) {
      return undefined;
    }
    const selectionText = document.getText(range);
    const trimmed = selectionText.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    // Skip selections that contain markup — those are for the extract-snippet
    // refactor, not this one. A variable reference can only replace plain
    // prose.
    if (trimmed.includes("<") || trimmed.includes(">")) {
      return undefined;
    }

    const projectContext = await this.projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      return undefined;
    }
    const entries = await this.variableIndex.getEntries(projectContext);
    const matches = findVariablesByValue(entries, trimmed);
    if (matches.length === 0) {
      return undefined;
    }

    if (matches.length === 1) {
      const only = matches[0];
      const action = new vscode.CodeAction(
        `Replace with <MadCap:variable name="${only.qualifiedName}" />`,
        vscode.CodeActionKind.RefactorRewrite
      );
      action.command = {
        command: COMMAND,
        title: "Replace with variable",
        arguments: [document.uri, range, only.qualifiedName]
      };
      return [action];
    }
    const action = new vscode.CodeAction(
      `Replace with a matching variable… (${matches.length} matches)`,
      vscode.CodeActionKind.RefactorRewrite
    );
    action.command = {
      command: COMMAND,
      title: "Replace with variable",
      arguments: [document.uri, range, undefined]
    };
    return [action];
  }
}

/**
 * Registers the companion command that backs {@link LiteralToVariableCodeActionProvider}.
 * Accepts either a preselected qualified variable name (when there is a
 * single match) or `undefined` (when the provider found several matches and
 * needs to show a picker).
 */
export function registerReplaceSelectionWithVariableCommand(
  projectResolver: FlareProjectResolver,
  variableIndex: VariableIndex
): vscode.Disposable {
  return vscode.commands.registerCommand(
    COMMAND,
    async (uri?: vscode.Uri, range?: vscode.Range, preselectedName?: string) => {
      if (!uri || !range) {
        return;
      }
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        return;
      }
      let chosenName = preselectedName;
      if (!chosenName) {
        const projectContext = await projectResolver
          .resolveForFile(document.uri)
          .catch(() => undefined);
        if (!projectContext) {
          return;
        }
        const selectionText = document.getText(range);
        const entries = await variableIndex.getEntries(projectContext);
        const matches = findVariablesByValue(entries, selectionText);
        if (matches.length === 0) {
          return;
        }
        const picked = await vscode.window.showQuickPick(
          matches.map((entry) => ({
            label: entry.qualifiedName,
            description: entry.value,
            detail: `Defined in ${entry.setName}.flvar`,
            entry
          })),
          {
            title: "Flare: Pick a variable",
            placeHolder: "Multiple variables share this value — pick one"
          }
        );
        if (!picked) {
          return;
        }
        chosenName = picked.entry.qualifiedName;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        range,
        `<MadCap:variable name="${escapeAttribute(chosenName)}" />`
      );
      await vscode.workspace.applyEdit(edit);
    }
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
