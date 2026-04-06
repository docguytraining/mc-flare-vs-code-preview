import * as path from "node:path";
import * as vscode from "vscode";
import {
  DiagnosticEntry,
  FlareProjectContext,
  PreviewDiagnostics,
  StylesheetBundle,
  TransformResult,
  VariableResolutionResult
} from "../core/types";
import { sanitizeCss, sanitizeHtml } from "../security/contentSanitizer";
import { logWarning } from "../core/logger";
import { RenderCoordinator } from "./renderCoordinator";

const PANEL_VIEW_TYPE = "flare.previewPanel";
const DEFAULT_DEBOUNCE_MS = 800;
const COALESCE_MS = 10_000;

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
  private lastRenderedAt: Date | undefined;
  private readonly coordinator: RenderCoordinator;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly dataResolver: PreviewDataResolver
  ) {
    this.coordinator = new RenderCoordinator({
      debounceMs: readTypingDebounceMs(),
      coalesceMs: COALESCE_MS
    });

    this.panel.onDidDispose(() => {
      this.coordinator.dispose();
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
        localResourceRoots: buildLocalResourceRoots(extensionUri, document)
      }
    );

    FlarePreviewPanel.currentPanel = new FlarePreviewPanel(panel, extensionUri, dataResolver);
    return FlarePreviewPanel.currentPanel.update(document);
  }

  /** Authoritative refresh (save / dependency change) for the active panel. */
  public static refreshCurrent(dataResolver: PreviewDataResolver): void {
    const panel = FlarePreviewPanel.currentPanel;
    if (!panel?.currentDocumentUri) {
      return;
    }
    panel.coordinator.schedule(() => panel.renderCurrent(dataResolver));
  }

  /** Debounced typing refresh for the active panel. */
  public static scheduleTypingRefresh(
    changedUri: vscode.Uri,
    dataResolver: PreviewDataResolver
  ): void {
    const panel = FlarePreviewPanel.currentPanel;
    if (!panel?.currentDocumentUri) {
      return;
    }
    if (panel.currentDocumentUri.toString() !== changedUri.toString()) {
      return;
    }
    panel.coordinator.scheduleDebounced(() => panel.renderCurrent(dataResolver));
  }

  public async update(document: vscode.TextDocument): Promise<void> {
    this.currentDocumentUri = document.uri;
    await this.renderWith(document, this.dataResolver);
  }

  private async renderCurrent(dataResolver: PreviewDataResolver): Promise<void> {
    if (!this.currentDocumentUri) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(this.currentDocumentUri);
    await this.renderWith(document, dataResolver);
  }

  private async renderWith(
    document: vscode.TextDocument,
    dataResolver: PreviewDataResolver
  ): Promise<void> {
    this.currentDocumentUri = document.uri;
    this.panel.title = `Flare Preview: ${path.basename(document.fileName)}`;
    const previewData = await dataResolver(document);
    this.lastRenderedAt = new Date();
    this.panel.webview.html = this.getWebviewContent(document, previewData);
  }

  private getWebviewContent(document: vscode.TextDocument, previewData: PreviewData): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const cspSource = webview.cspSource;

    const baseStylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "preview.css")
    );

    // Deterministic stylesheet order preserved from the resolver; each block
    // is scrubbed of external url()/@import references before being inlined.
    const inlinedCssParts: string[] = [];
    let externalCssRefsBlocked = 0;
    for (const entry of previewData.stylesheetBundle.inlinedCss) {
      const scrubbed = sanitizeCss(entry.content);
      externalCssRefsBlocked += scrubbed.removed;
      inlinedCssParts.push(`\n/* ${escapeHtml(entry.source.fsPath)} */\n${scrubbed.css}`);
    }
    if (externalCssRefsBlocked > 0) {
      logWarning(
        `Blocked ${externalCssRefsBlocked} external CSS reference(s) in stylesheets for ${document.uri.fsPath}.`
      );
    }
    const inlinedCss = inlinedCssParts.join("\n");

    const sanitizedTopic = sanitizeHtml(previewData.transformResult.html);
    if (sanitizedTopic.removed.length > 0) {
      logWarning(
        `Sanitizer removed ${sanitizedTopic.removed.join(", ")} from ${document.uri.fsPath}.`
      );
    }

    const rewrittenTopicHtml = rewriteLocalResourceUrls(
      sanitizedTopic.html,
      document.uri,
      previewData.projectContext,
      webview
    );

    const summary = this.renderSummary(previewData);
    const statusBar = this.renderStatusBar(previewData);
    const diagnosticList = this.renderDiagnostics(previewData.diagnostics.entries);
    const sanitizerNotice = this.renderSanitizerNotice(sanitizedTopic.removed);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MadCap Flare Preview</title>
    <link rel="stylesheet" href="${baseStylesheetUri}" />
    <style>${inlinedCss}</style>
  </head>
  <body>
    <header>
      <h1>MadCap Flare Preview</h1>
      ${statusBar}
      <p class="file-path">${escapeHtml(document.uri.fsPath)}</p>
    </header>
    ${sanitizerNotice}
    <section class="summary">${summary}</section>
    <section class="diagnostics">${diagnosticList}</section>
    <main>
      <section class="rendered-topic">
        <h2>Rendered Topic</h2>
        <article class="topic-frame">${rewrittenTopicHtml}</article>
      </section>
    </main>
    <script nonce="${nonce}">/* reserved for future preview interactivity */</script>
  </body>
</html>`;
  }

  private renderStatusBar(previewData: PreviewData): string {
    const projectFile = previewData.projectContext?.projectFile.fsPath ?? "No Flare project detected";
    const errorCount = previewData.diagnostics.entries.filter((entry) => entry.severity === "error").length;
    const warningCount = previewData.diagnostics.entries.filter((entry) => entry.severity === "warning").length;
    const renderedAt = this.lastRenderedAt
      ? this.lastRenderedAt.toLocaleTimeString()
      : "pending";
    const warningClass = errorCount > 0 ? "warn" : warningCount > 0 ? "warn" : "ok";

    return `
      <ul class="status-bar">
        <li><strong>Last render:</strong> ${escapeHtml(renderedAt)}</li>
        <li><strong>Project:</strong> ${escapeHtml(projectFile)}</li>
        <li class="${warningClass}"><strong>Warnings:</strong> ${warningCount}</li>
        <li class="${errorCount > 0 ? "warn" : "ok"}"><strong>Errors:</strong> ${errorCount}</li>
      </ul>
    `;
  }

  private renderSanitizerNotice(removed: string[]): string {
    if (removed.length === 0) {
      return "";
    }
    return `<p class="sanitizer-notice">Preview sanitizer removed: ${escapeHtml(removed.join(", "))}.</p>`;
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

  private renderDiagnostics(entries: DiagnosticEntry[]): string {
    if (entries.length === 0) {
      return "<h2>Diagnostics</h2><p class=\"ok\">No diagnostics.</p>";
    }

    const items = entries
      .map((entry) => {
        const hintMarkup = entry.hint ? ` <em class="hint">${escapeHtml(entry.hint)}</em>` : "";
        const sourceMarkup = entry.source
          ? ` <span class="source">(${escapeHtml(entry.source)})</span>`
          : "";
        return `<li class="diagnostic severity-${entry.severity}" data-code="${escapeHtml(entry.code)}"><strong>[${escapeHtml(entry.severity)}]</strong> ${escapeHtml(entry.message)}${hintMarkup}${sourceMarkup}</li>`;
      })
      .join("\n");
    return `<h2>Diagnostics</h2><ul class="warnings">${items}</ul>`;
  }
}

function buildLocalResourceRoots(
  extensionUri: vscode.Uri,
  document: vscode.TextDocument
): vscode.Uri[] {
  const roots: vscode.Uri[] = [vscode.Uri.joinPath(extensionUri, "media")];
  const seen = new Set<string>(roots.map((root) => root.fsPath));

  const addRoot = (uri: vscode.Uri): void => {
    if (!seen.has(uri.fsPath)) {
      seen.add(uri.fsPath);
      roots.push(uri);
    }
  };

  // Only expose the enclosing workspace folder, not every folder, so the
  // webview cannot reach into unrelated projects.
  const owningFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (owningFolder) {
    addRoot(owningFolder.uri);
  }

  addRoot(vscode.Uri.file(path.dirname(document.uri.fsPath)));
  return roots;
}

function readTypingDebounceMs(): number {
  const configured = vscode.workspace
    .getConfiguration("flarePreview")
    .get<number>("typingDebounceMs", DEFAULT_DEBOUNCE_MS);
  if (typeof configured !== "number" || Number.isNaN(configured)) {
    return DEFAULT_DEBOUNCE_MS;
  }
  return Math.max(300, configured);
}

const LOCAL_RESOURCE_ATTR_REGEX = /\b(src|href)\s*=\s*(["'])([^"']+)\2/gi;

function rewriteLocalResourceUrls(
  html: string,
  documentUri: vscode.Uri,
  _projectContext: FlareProjectContext | undefined,
  webview: vscode.Webview
): string {
  const documentDir = path.dirname(documentUri.fsPath);

  return html.replace(LOCAL_RESOURCE_ATTR_REGEX, (full, attr: string, quote: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isExternalOrDataUrl(trimmed) || isAnchorOrFragment(trimmed)) {
      return full;
    }

    const resolved = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(documentDir, trimmed);

    const webviewUri = webview.asWebviewUri(vscode.Uri.file(resolved));
    return `${attr}=${quote}${webviewUri.toString()}${quote}`;
  });
}

function isExternalOrDataUrl(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("vscode-webview://") ||
    value.startsWith("//")
  );
}

function isAnchorOrFragment(value: string): boolean {
  return value.startsWith("#") || value.startsWith("javascript:");
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
