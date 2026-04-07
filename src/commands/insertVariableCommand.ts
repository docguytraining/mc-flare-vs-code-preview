import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { VariableIndex, VariableIndexEntry } from "../flare/variableIndex";

interface VariableQuickPickItem extends vscode.QuickPickItem {
  entry: VariableIndexEntry;
}

/**
 * Registers `flare.insertVariable`. Opens a project-wide quick pick of every
 * variable known to the `VariableResolver` and inserts
 * `<MadCap:variable name="Set.Name" />` at the cursor.
 *
 * Companion entry points: the `@@` bracket completion (typing two ats in
 * prose) and the `var` keyword scaffold in the existing static snippet
 * completion provider.
 */
export function registerInsertVariableCommand(
  projectResolver: FlareProjectResolver,
  variableIndex: VariableIndex
): vscode.Disposable {
  return vscode.commands.registerCommand("flare.insertVariable", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a Flare topic before inserting a variable.");
      return;
    }
    const document = editor.document;
    const projectContext = await projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      vscode.window.showWarningMessage(
        "Flare: no .flprj project was found above this topic. Variable insertion requires a project."
      );
      return;
    }
    const entries = await variableIndex.getEntries(projectContext);
    if (entries.length === 0) {
      vscode.window.showInformationMessage(
        "Flare: no variables are defined in this project's .flvar files."
      );
      return;
    }

    const items: VariableQuickPickItem[] = entries.map((entry) => ({
      entry,
      label: entry.qualifiedName,
      description: truncate(entry.value, 80),
      detail: `Defined in ${entry.setName}.flvar`
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "Flare: Insert Variable",
      placeHolder: "Search variables by name or value…",
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) {
      return;
    }

    const snippet = new vscode.SnippetString(
      `<MadCap:variable name="${escapeAttribute(picked.entry.qualifiedName)}" />$0`
    );
    await editor.insertSnippet(snippet, editor.selection);
  });
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
