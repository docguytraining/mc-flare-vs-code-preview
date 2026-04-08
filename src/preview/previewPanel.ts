import * as path from "node:path";
import * as vscode from "vscode";
import {
  DiagnosticEntry,
  FlareProjectContext,
  PreviewConditionInventory,
  PreviewDiagnostics,
  PreviewTargetInfo,
  StylesheetBundle,
  TransformResult,
  VariableResolutionResult
} from "../core/types";
import { sanitizeCss, sanitizeHtml } from "../security/contentSanitizer";
import { transformFlareCss } from "../flare/flareCssTransform";
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
  conditions: PreviewConditionInventory;
  availableTargets: PreviewTargetInfo[];
  activeTargetId: string;
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

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.command === "openTopic" && typeof message.href === "string") {
        void this.handleOpenTopic(message.href);
      } else if (message?.command === "pickTarget") {
        void vscode.commands.executeCommand("flare.pickPreviewTarget", this.currentDocumentUri);
      } else if (
        message?.command === "openConditionInTopic" &&
        typeof message.tag === "string" &&
        this.currentDocumentUri
      ) {
        void vscode.commands.executeCommand(
          "flare.openConditionInTopic",
          this.currentDocumentUri,
          message.tag
        );
      }
    });
  }

  private async handleOpenTopic(href: string): Promise<void> {
    const baseUri = this.currentDocumentUri;
    if (!baseUri) {
      return;
    }
    const [pathPart, anchorPart] = splitHash(href);
    if (!pathPart && !anchorPart) {
      return;
    }

    const documentDir = path.dirname(baseUri.fsPath);
    const candidate = pathPart.length > 0 ? path.resolve(documentDir, pathPart) : baseUri.fsPath;

    // Only open files that live inside the current workspace folder, so a
    // crafted postMessage can't reach files outside the project tree.
    const owningFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidate));
    if (!owningFolder) {
      logWarning(`Refusing to open xref target outside workspace: ${candidate}`);
      return;
    }

    try {
      const targetDocument = await vscode.workspace.openTextDocument(candidate);
      const editor = await vscode.window.showTextDocument(targetDocument, {
        viewColumn: vscode.ViewColumn.One,
        preview: false
      });
      if (anchorPart) {
        revealAnchor(editor, anchorPart);
      }
    } catch (error) {
      logWarning(`Failed to open xref target ${candidate}: ${String(error)}`);
    }
  }

  public static show(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    dataResolver: PreviewDataResolver
  ): Promise<void> {
    if (FlarePreviewPanel.currentPanel) {
      // preserveFocus=true keeps the editor active so the author can keep
      // typing without having to click back into the editor pane after the
      // keybinding fires.
      FlarePreviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, true);
      return FlarePreviewPanel.currentPanel.update(document);
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      "MadCap Flare Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: buildLocalResourceRoots(extensionUri, document)
      }
    );

    FlarePreviewPanel.currentPanel = new FlarePreviewPanel(panel, extensionUri, dataResolver);
    return FlarePreviewPanel.currentPanel.update(document);
  }

  /**
   * Toggle-aware entry point used by the keybinding. Three cases:
   *
   *   1. No panel open → behave like {@link show}: open it on this document.
   *   2. Panel open and already showing this document → close it. This is
   *      the "toggle off" case the keybinding mostly exists for.
   *   3. Panel open but showing a different document → switch the panel to
   *      this document instead of closing it. Matches Markdown preview's
   *      behavior and is what authors expect when they jump between topics.
   */
  public static toggleOrShow(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    dataResolver: PreviewDataResolver
  ): Promise<void> {
    const existing = FlarePreviewPanel.currentPanel;
    if (!existing) {
      return FlarePreviewPanel.show(extensionUri, document, dataResolver);
    }
    if (
      existing.currentDocumentUri &&
      existing.currentDocumentUri.toString() === document.uri.toString()
    ) {
      existing.panel.dispose();
      return Promise.resolve();
    }
    existing.panel.reveal(vscode.ViewColumn.Beside, true);
    return existing.update(document);
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

    // Deterministic stylesheet order preserved from the resolver. For each
    // file we (1) translate Flare-specific CSS properties (mc-auto-number-
    // format → :before { content }) so admonition labels appear, then
    // (2) scrub external url()/@import references for safety.
    const inlinedCssParts: string[] = [];
    let externalCssRefsBlocked = 0;
    let flareRulesGenerated = 0;
    for (const entry of previewData.stylesheetBundle.inlinedCss) {
      const flareTransformed = transformFlareCss(entry.content);
      flareRulesGenerated += flareTransformed.generatedRuleCount;
      const scrubbed = sanitizeCss(flareTransformed.css);
      externalCssRefsBlocked += scrubbed.removed;
      inlinedCssParts.push(`\n/* ${escapeHtml(entry.source.fsPath)} */\n${scrubbed.css}`);
    }
    if (externalCssRefsBlocked > 0) {
      logWarning(
        `Blocked ${externalCssRefsBlocked} external CSS reference(s) in stylesheets for ${document.uri.fsPath}.`
      );
    }
    if (flareRulesGenerated > 0) {
      logWarning(
        `Generated ${flareRulesGenerated} :before companion rule(s) from mc-auto-number-format declarations for ${document.uri.fsPath}.`
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
    const conditionsSection = this.renderConditions(previewData);
    const statusBar = this.renderStatusBar(previewData);
    const targetPicker = this.renderTargetPicker(previewData);
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
  <body class="flare-preview-body">
    <header class="flare-preview-header">
      <h1>MadCap Flare Preview</h1>
      ${statusBar}
      ${targetPicker}
      <p class="file-path">${escapeHtml(document.uri.fsPath)}</p>
    </header>
    ${sanitizerNotice}
    <section class="flare-preview-summary">${summary}</section>
    <section class="flare-preview-conditions">${conditionsSection}</section>
    <section class="flare-preview-diagnostics">${diagnosticList}</section>
    <main>
      <section class="flare-preview-rendered">
        <h2>Rendered Topic</h2>
        <article class="topic-frame">${rewrittenTopicHtml}</article>
      </section>
    </main>
    <script nonce="${nonce}">
      (function () {
        const vscode = acquireVsCodeApi();
        document.addEventListener("click", function (event) {
          const target = event.target instanceof Element ? event.target : null;
          if (!target) {
            return;
          }
          const picker = target.closest("button.flare-target-picker");
          if (picker) {
            event.preventDefault();
            vscode.postMessage({ command: "pickTarget" });
            return;
          }
          const conditionRow = target.closest("button.flare-condition-row");
          if (conditionRow) {
            event.preventDefault();
            const tag = conditionRow.getAttribute("data-tag");
            if (tag) {
              vscode.postMessage({ command: "openConditionInTopic", tag: tag });
            }
            return;
          }
          const anchor = target.closest("a.flare-xref");
          if (!anchor) {
            return;
          }
          const href = anchor.getAttribute("data-flare-xref");
          if (!href) {
            return;
          }
          event.preventDefault();
          vscode.postMessage({ command: "openTopic", href: href });
        });
      })();
    </script>
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

  private renderTargetPicker(previewData: PreviewData): string {
    if (previewData.availableTargets.length === 0) {
      return "";
    }
    const active = previewData.availableTargets.find(
      (target) => target.id === previewData.activeTargetId
    );
    const label = active?.displayName ?? "Show everything";
    return `
      <div class="flare-target-picker-row">
        <span class="flare-target-label"><strong>Target:</strong> ${escapeHtml(label)}</span>
        <button class="flare-target-picker" type="button">Change…</button>
      </div>
    `;
  }

  private renderConditions(previewData: PreviewData): string {
    const elementCounts = [...previewData.conditions.elementConditionCounts.entries()];
    const snippetCounts = [...previewData.conditions.snippetConditionCounts.entries()];

    if (elementCounts.length === 0 && snippetCounts.length === 0) {
      return "<h2>Conditions</h2><p class=\"ok\">No condition tags referenced in this topic.</p>";
    }

    const renderColumn = (
      title: string,
      entries: Array<[string, number]>
    ): string => {
      if (entries.length === 0) {
        return `<div class="condition-column"><h3>${escapeHtml(title)}</h3><p class="ok">None.</p></div>`;
      }
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      const items = entries
        .map(([name, count]) => {
          const safeTag = escapeHtml(name);
          return `<li><button type="button" class="flare-condition-row" data-tag="${safeTag}" title="Jump to this condition in the topic"><code>${safeTag}</code> <span class="condition-count">(${count})</span></button></li>`;
        })
        .join("");
      return `<div class="condition-column"><h3>${escapeHtml(title)}</h3><ul>${items}</ul></div>`;
    };

    const hidden = previewData.conditions.hiddenCount;
    const hiddenNote =
      hidden > 0
        ? `<p class="condition-hidden-note">Hidden by active target: ${hidden} element(s).</p>`
        : "";

    return `
      <h2>Conditions</h2>
      ${hiddenNote}
      <div class="condition-grid">
        ${renderColumn("Element conditions", elementCounts)}
        ${renderColumn("Snippet conditions", snippetCounts)}
      </div>
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
    .getConfiguration("flareToolkit")
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
  return value.startsWith("#");
}

function splitHash(href: string): [string, string | undefined] {
  const trimmed = href.trim();
  const index = trimmed.indexOf("#");
  if (index < 0) {
    return [trimmed, undefined];
  }
  return [trimmed.slice(0, index), trimmed.slice(index + 1)];
}

function revealAnchor(editor: vscode.TextEditor, anchor: string): void {
  const text = editor.document.getText();
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRegex = new RegExp(
    `(?:id|name)\\s*=\\s*["']${escaped}["']|<MadCap:anchor\\b[^>]*\\bname\\s*=\\s*["']${escaped}["']`,
    "i"
  );
  const match = anchorRegex.exec(text);
  if (!match) {
    return;
  }
  const position = editor.document.positionAt(match.index);
  const range = new vscode.Range(position, position);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
