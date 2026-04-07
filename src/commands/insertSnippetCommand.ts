import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { SnippetIndex, SnippetIndexEntry } from "../flare/snippetIndex";

interface SnippetQuickPickItem extends vscode.QuickPickItem {
  entry: SnippetIndexEntry;
}

/**
 * Registers `flare.insertSnippet`. Opens a project-wide quick pick of every
 * `.flsnp` file under the active topic's project root and inserts a
 * `<MadCap:snippetBlock src="…" />` reference at the cursor.
 *
 * Companion entry points: the `{{` bracket completion (typing two left
 * braces in prose), the `<MadCap:snippet src="` attribute completion, and
 * the `snip`/`snipblock` keyword snippet completions.
 */
export function registerInsertSnippetCommand(
  projectResolver: FlareProjectResolver,
  snippetIndex: SnippetIndex
): vscode.Disposable {
  return vscode.commands.registerCommand("flare.insertSnippet", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a Flare topic before inserting a snippet.");
      return;
    }
    const document = editor.document;
    const projectContext = await projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      vscode.window.showWarningMessage(
        "Flare: no .flprj project was found above this topic. Snippet insertion requires a project."
      );
      return;
    }
    const entries = await snippetIndex.getEntries(projectContext);
    if (entries.length === 0) {
      vscode.window.showInformationMessage(
        "Flare: no .flsnp snippets were found in this project."
      );
      return;
    }

    const items: SnippetQuickPickItem[] = entries.map((entry) => ({
      entry,
      label: entry.name,
      description: entry.relPath,
      detail: entry.preview
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "Flare: Insert Snippet",
      placeHolder: "Search snippets by name, path, or preview text…",
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) {
      return;
    }

    const srcAttribute = path
      .relative(path.dirname(document.uri.fsPath), picked.entry.absPath)
      .replace(/\\/g, "/");
    const snippet = new vscode.SnippetString(
      `<MadCap:snippetBlock src="${escapeSnippet(srcAttribute)}" />$0`
    );
    await editor.insertSnippet(snippet, editor.selection);
  });
}

function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}
