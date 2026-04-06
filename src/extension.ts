import * as vscode from "vscode";
import { FlarePreviewPanel } from "./preview/previewPanel";

const FLARE_PREVIEW_COMMAND = "flare.previewHtml";
const FLARE_FILE_EXTENSIONS = new Set([".htm", ".html"]);

export function activate(context: vscode.ExtensionContext): void {
  const previewCommand = vscode.commands.registerCommand(
    FLARE_PREVIEW_COMMAND,
    async (resource?: vscode.Uri) => {
      const document = await resolveDocument(resource);
      if (!document) {
        return;
      }

      if (!isFlareHtmlDocument(document)) {
        vscode.window.showWarningMessage(
          "Flare preview works with .htm and .html files."
        );
        return;
      }

      FlarePreviewPanel.show(context.extensionUri, document);
    }
  );

  context.subscriptions.push(previewCommand);
}

export function deactivate(): void {
  // No cleanup required yet.
}

async function resolveDocument(resource?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (resource) {
    return vscode.workspace.openTextDocument(resource);
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    return activeDocument;
  }

  vscode.window.showInformationMessage(
    "Open a .htm or .html file and run Flare: Preview HTML Topic."
  );

  return undefined;
}

function isFlareHtmlDocument(document: vscode.TextDocument): boolean {
  const path = document.uri.fsPath.toLowerCase();
  for (const extension of FLARE_FILE_EXTENSIONS) {
    if (path.endsWith(extension)) {
      return true;
    }
  }
  return false;
}
