import * as vscode from "vscode";

const PANEL_VIEW_TYPE = "flare.previewPanel";

export class FlarePreviewPanel {
  private static currentPanel: FlarePreviewPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel.onDidDispose(() => {
      FlarePreviewPanel.currentPanel = undefined;
    });
  }

  public static show(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument
  ): void {
    if (FlarePreviewPanel.currentPanel) {
      FlarePreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      FlarePreviewPanel.currentPanel.update(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "MadCap Flare Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")]
      }
    );

    FlarePreviewPanel.currentPanel = new FlarePreviewPanel(panel, extensionUri);
    FlarePreviewPanel.currentPanel.update(document);
  }

  public update(document: vscode.TextDocument): void {
    this.panel.title = `Flare Preview: ${document.fileName.split(/[\\/]/).pop() ?? "topic"}`;
    this.panel.webview.html = this.getWebviewContent(document);
  }

  private getWebviewContent(document: vscode.TextDocument): string {
    const stylesheetUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "preview.css")
    );

    const escapedContent = escapeHtml(document.getText());

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MadCap Flare Preview</title>
    <link rel="stylesheet" href="${stylesheetUri}" />
  </head>
  <body>
    <header>
      <h1>MadCap Flare Preview (Phase 1)</h1>
      <p>Raw HTML topic content is shown below. Flare-aware transforms arrive in later phases.</p>
      <p class="file-path">${escapeHtml(document.uri.fsPath)}</p>
    </header>
    <main>
      <pre>${escapedContent}</pre>
    </main>
  </body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
