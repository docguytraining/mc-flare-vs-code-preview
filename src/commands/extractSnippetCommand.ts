import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { SnippetIndex } from "../flare/snippetIndex";
import {
  buildSnippetFileContent,
  computeSnippetSrcAttribute,
  slugifySnippetName,
  stripCommonIndent
} from "./extractSnippetHelpers";

const SNIPPETS_FOLDER = path.join("Content", "Resources", "Snippets");

interface FolderQuickPickItem extends vscode.QuickPickItem {
  /** Absolute path of the destination folder, or `__new__` for create-new. */
  folderPath: string;
}

const NEW_FOLDER_SENTINEL = "__new__";

/**
 * Registers `flare.extractSelectionAsSnippet`. Reads the active editor's
 * non-empty selection, prompts for a snippet name and a destination folder
 * under `Content/Resources/Snippets`, then applies a single
 * {@link vscode.WorkspaceEdit} that creates the new `.flsnp` file and
 * replaces the selection with a `<MadCap:snippetBlock src="…"/>` reference.
 *
 * The whole rewrite is one undo step. After the edit succeeds, the new
 * snippet file is opened in a side editor for review.
 */
export function registerExtractSnippetCommand(
  projectResolver: FlareProjectResolver,
  snippetIndex: SnippetIndex
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "flare.extractSelectionAsSnippet",
    async (uri?: vscode.Uri, range?: vscode.Range) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage(
          "Open a Flare topic and select the prose you want to extract."
        );
        return;
      }
      const document = editor.document;
      // The code action passes (uri, range); the palette command relies on
      // the active editor's current selection. Both routes converge here.
      let selectionRange: vscode.Range = range ?? editor.selection;
      if (uri && uri.toString() !== document.uri.toString()) {
        vscode.window.showWarningMessage(
          "Flare: extract snippet must be run from the active editor."
        );
        return;
      }
      if (selectionRange.isEmpty) {
        vscode.window.showInformationMessage(
          "Flare: select the content you want to extract before running this command."
        );
        return;
      }

      const projectContext = await projectResolver
        .resolveForFile(document.uri)
        .catch(() => undefined);
      if (!projectContext) {
        vscode.window.showWarningMessage(
          "Flare: cannot extract because no .flprj project was found above this topic."
        );
        return;
      }

      const rawSelection = document.getText(selectionRange);
      const innerXhtml = stripCommonIndent(rawSelection.replace(/^\r?\n/, "").replace(/\s+$/g, ""));

      const nameInput = await vscode.window.showInputBox({
        title: "Extract as snippet",
        prompt: "Snippet name (letters, digits, dashes)",
        placeHolder: "e.g. installation-prereqs",
        validateInput: (value) => {
          const result = slugifySnippetName(value);
          return result.ok ? undefined : result.reason;
        }
      });
      if (!nameInput) {
        return;
      }
      const slugResult = slugifySnippetName(nameInput);
      if (!slugResult.ok) {
        return;
      }
      const slug = slugResult.slug;

      const folderItems = await buildFolderItems(projectContext.projectRoot.fsPath);
      const folderPick = await vscode.window.showQuickPick(folderItems, {
        title: "Destination folder",
        placeHolder: "Pick where the new .flsnp file should live"
      });
      if (!folderPick) {
        return;
      }

      let destinationFolder = folderPick.folderPath;
      if (destinationFolder === NEW_FOLDER_SENTINEL) {
        const subfolderInput = await vscode.window.showInputBox({
          title: "New snippet subfolder",
          prompt: `Folder name under ${SNIPPETS_FOLDER}`,
          placeHolder: "e.g. install"
        });
        if (!subfolderInput) {
          return;
        }
        const subfolderSlug = slugifySnippetName(subfolderInput);
        if (!subfolderSlug.ok) {
          vscode.window.showWarningMessage(`Flare: ${subfolderSlug.reason}`);
          return;
        }
        destinationFolder = path.join(
          projectContext.projectRoot.fsPath,
          SNIPPETS_FOLDER,
          subfolderSlug.slug
        );
      }

      const newSnippetPath = path.join(destinationFolder, `${slug}.flsnp`);
      try {
        await fs.access(newSnippetPath);
        const choice = await vscode.window.showWarningMessage(
          `Flare: ${path.basename(newSnippetPath)} already exists in this folder.`,
          { modal: true },
          "Overwrite",
          "Cancel"
        );
        if (choice !== "Overwrite") {
          return;
        }
      } catch {
        // File does not exist — continue.
      }

      const fileContent = buildSnippetFileContent(innerXhtml);
      const srcAttribute = computeSnippetSrcAttribute(document.uri.fsPath, newSnippetPath);

      // Choose snippet vs snippetBlock based on whether the original selection
      // was a block-level construct. The simplest signal is whether it spanned
      // multiple lines or contained a block element opener.
      const isBlock =
        rawSelection.includes("\n") ||
        /<(p|div|ul|ol|li|table|h[1-6]|section|article|figure|blockquote|pre)\b/i.test(rawSelection);
      const replacement = isBlock
        ? `<MadCap:snippetBlock src="${escapeAttribute(srcAttribute)}" />`
        : `<MadCap:snippet src="${escapeAttribute(srcAttribute)}" />`;

      const edit = new vscode.WorkspaceEdit();
      const newSnippetUri = vscode.Uri.file(newSnippetPath);
      edit.createFile(newSnippetUri, {
        overwrite: true,
        contents: Buffer.from(fileContent, "utf8")
      });
      edit.replace(document.uri, selectionRange, replacement);

      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        vscode.window.showErrorMessage("Flare: failed to apply the snippet extraction edit.");
        return;
      }
      snippetIndex.invalidateForPath(newSnippetPath);

      try {
        const snippetDocument = await vscode.workspace.openTextDocument(newSnippetUri);
        await vscode.window.showTextDocument(snippetDocument, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false
        });
      } catch {
        // Best effort — the edit already succeeded.
      }
    }
  );
}

async function buildFolderItems(projectRoot: string): Promise<FolderQuickPickItem[]> {
  const snippetsRoot = path.join(projectRoot, SNIPPETS_FOLDER);
  const items: FolderQuickPickItem[] = [
    {
      label: `$(folder) ${SNIPPETS_FOLDER.replace(/\\/g, "/")}`,
      description: "Top of the snippets folder",
      folderPath: snippetsRoot
    }
  ];
  const subfolders = await listSubfolders(snippetsRoot);
  for (const sub of subfolders) {
    const absPath = path.join(snippetsRoot, sub);
    items.push({
      label: `$(folder) ${SNIPPETS_FOLDER.replace(/\\/g, "/")}/${sub}`,
      description: `${sub}/`,
      folderPath: absPath
    });
  }
  items.push({
    label: "$(new-folder) Create new subfolder…",
    description: "Add a new folder under Content/Resources/Snippets",
    folderPath: NEW_FOLDER_SENTINEL
  });
  return items;
}

async function listSubfolders(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        folders.push(entry.name);
      }
    }
    folders.sort((a, b) => a.localeCompare(b));
    return folders;
  } catch {
    return [];
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
