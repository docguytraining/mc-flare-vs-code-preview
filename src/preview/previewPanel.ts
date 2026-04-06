import * as vscode from "vscode";
import {
  FlareProjectContext,
  PreviewDiagnostics,
  StylesheetBundle,
  TransformResult,
  VariableResolutionResult
} from "../core/types";

const PANEL_VIEW_TYPE = "flare.previewPanel";

type PreviewData = {
  projectContext: FlareProjectContext | undefined;
  variableResult: VariableResolutionResult;
  stylesheetBundle: StylesheetBundle;
  transformResult: TransformResult;
  diagnostics: PreviewDiagnostics;
};

type PreviewDataResolver = (document: vscode.TextDocument) => Promise<PreviewData>;

export class FlarePreviewPanel {
  private static currentPanel: FlarePreviewPanel | undefined;
  private currentDocumentUri: vscode.Uri | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly dataResolver: PreviewDataResolver
  ) {
    this.panel.onDidDispose(() => {
      FlarePreviewPanel.currentPanel = undefined;
    });
  }

  public static show(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    dataResolver: PreviewDataResolver
  ): Promise<void> {
    if (FlarePreviewPanel.currentPanel) {
      FlarePreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return FlarePreviewPanel.currentPanel.update(document);
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "MadCap Flare Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
          ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
        ]
      }
    );

    FlarePreviewPanel.currentPanel = new FlarePreviewPanel(panel, extensionUri, dataResolver);
    return FlarePreviewPanel.currentPanel.update(document);
  }

  public static async refreshCurrent(dataResolver: PreviewDataResolver): Promise<void> {
    if (!FlarePreviewPanel.currentPanel?.currentDocumentUri) {
      return;
    }

    const currentPanel = FlarePreviewPanel.currentPanel;
    const currentDocumentUri = currentPanel.currentDocumentUri;
    if (!currentDocumentUri) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(currentDocumentUri);
    await currentPanel.updateWithResolver(document, dataResolver);
  }

  public async update(document: vscode.TextDocument): Promise<void> {
    await this.updateWithResolver(document, this.dataResolver);
  }

  private async updateWithResolver(
    document: vscode.TextDocument,
    dataResolver: PreviewDataResolver
  ): Promise<void> {
    this.currentDocumentUri = document.uri;
    this.panel.title = `Flare Preview: ${document.fileName.split(/[\\/]/).pop() ?? "topic"}`;
    const previewData = await dataResolver(document);
    this.panel.webview.html = this.getWebviewContent(document, previewData);
  }

  private getWebviewContent(document: vscode.TextDocument, previewData: PreviewData): string {
    const stylesheetUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "preview.css")
    );

    const escapedContent = escapeHtml(document.getText());
    const summary = this.renderSummary(previewData);
    const diagnosticList = this.renderDiagnostics(previewData.diagnostics.warnings);
    const inlinedCss = previewData.stylesheetBundle.inlinedCss
      .map((entry) => `\n/* ${escapeHtml(entry.source.fsPath)} */\n${entry.content}`)
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MadCap Flare Preview</title>
    <link rel="stylesheet" href="${stylesheetUri}" />
    <style>${inlinedCss}</style>
  </head>
  <body>
    <header>
      <h1>MadCap Flare Preview (Phase 3)</h1>
      <p>MadCap-aware transformation is active for variables, conditionals, drop-downs, and snippets.</p>
      <p class="file-path">${escapeHtml(document.uri.fsPath)}</p>
    </header>
    <section class="summary">${summary}</section>
    <section class="diagnostics">${diagnosticList}</section>
    <main>
      <section class="rendered-topic">
        <h2>Rendered Topic</h2>
        <article class="topic-frame">${previewData.transformResult.html}</article>
      </section>
      <details>
        <summary>Source Topic</summary>
        <pre>${escapedContent}</pre>
      </details>
    </main>
  </body>
</html>`;
  }

  private renderSummary(previewData: PreviewData): string {
    const projectFile = previewData.projectContext?.projectFile.fsPath ?? "Not found";
    const projectRoot = previewData.projectContext?.projectRoot.fsPath ?? "Not found";
    const variableFileCount = previewData.projectContext?.variableFiles.length ?? 0;
    const resolvedVariableCount = previewData.variableResult.variables.size;
    const stylesheetCount = previewData.stylesheetBundle.stylesheets.length;
    const transformWarningCount = previewData.transformResult.warnings.length;

    return `
      <h2>Discovery Summary</h2>
      <ul>
        <li><strong>Project File:</strong> ${escapeHtml(projectFile)}</li>
        <li><strong>Project Root:</strong> ${escapeHtml(projectRoot)}</li>
        <li><strong>Variable Files:</strong> ${variableFileCount}</li>
        <li><strong>Resolved Variables:</strong> ${resolvedVariableCount}</li>
        <li><strong>Discovered Stylesheets:</strong> ${stylesheetCount}</li>
        <li><strong>Transform Warnings:</strong> ${transformWarningCount}</li>
      </ul>
    `;
  }

  private renderDiagnostics(warnings: string[]): string {
    if (warnings.length === 0) {
      return "<h2>Diagnostics</h2><p class=\"ok\">No warnings.</p>";
    }

    const items = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("\n");
    return `<h2>Diagnostics</h2><ul class=\"warnings\">${items}</ul>`;
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
