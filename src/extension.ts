import * as vscode from "vscode";
import { FlareProjectResolver } from "./core/flareProjectResolver";
import { FlarePreviewPanel } from "./preview/previewPanel";
import { resolveStylesheets } from "./flare/stylesheetResolver";
import { resolveVariables } from "./flare/variableResolver";
import { transformMadcapContent } from "./flare/madcapTransformPipeline";
import {
  FlareProjectContext,
  PreviewDiagnostics,
  StylesheetBundle,
  TransformResult,
  VariableResolutionResult
} from "./core/types";

const FLARE_PREVIEW_COMMAND = "flare.previewHtml";
const FLARE_FILE_EXTENSIONS = new Set([".htm", ".html"]);

export function activate(context: vscode.ExtensionContext): void {
  const projectResolver = new FlareProjectResolver();

  const buildPreviewData = async (
    document: vscode.TextDocument
  ): Promise<{
    projectContext: FlareProjectContext | undefined;
    variableResult: VariableResolutionResult;
    stylesheetBundle: StylesheetBundle;
    transformResult: TransformResult;
    diagnostics: PreviewDiagnostics;
  }> => {
    const projectContext = await projectResolver.resolveForFile(document.uri);
    const htmlContent = document.getText();
    const variableResult = await resolveVariables(htmlContent, projectContext);
    const stylesheetBundle = await resolveStylesheets(document, htmlContent, projectContext);
    const transformResult = await transformMadcapContent(htmlContent, {
      variables: variableResult.variables,
      projectContext,
      currentDocument: document.uri
    });

    const warnings: string[] = [];
    if (!projectContext) {
      warnings.push("No .flprj file found by walking up from this topic.");
    }

    if (variableResult.unresolvedReferences.length > 0) {
      warnings.push(
        `Unresolved variables: ${variableResult.unresolvedReferences
          .slice(0, 10)
          .join(", ")}${
          variableResult.unresolvedReferences.length > 10 ? " ..." : ""
        }`
      );
    }

    for (const missingStylesheet of stylesheetBundle.missingStylesheets) {
      warnings.push(`Missing stylesheet: ${missingStylesheet}`);
    }

    warnings.push(...transformResult.warnings);

    return {
      projectContext,
      variableResult,
      stylesheetBundle,
      transformResult,
      diagnostics: { warnings }
    };
  };

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

      await FlarePreviewPanel.show(context.extensionUri, document, buildPreviewData);
    }
  );

  const dependencyWatcher = vscode.workspace.createFileSystemWatcher("**/*.{flprj,flvar,css}");

  const onDependencyChanged = async (uri: vscode.Uri): Promise<void> => {
    projectResolver.invalidateForPath(uri.fsPath);
    await FlarePreviewPanel.refreshCurrent(buildPreviewData);
  };

  const onDidSave = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const autoRefresh = vscode.workspace
      .getConfiguration("flarePreview")
      .get<boolean>("autoRefreshOnSave", true);
    if (!autoRefresh) {
      return;
    }

    const lowerPath = document.uri.fsPath.toLowerCase();
    if (lowerPath.endsWith(".flprj") || lowerPath.endsWith(".flvar") || lowerPath.endsWith(".css")) {
      projectResolver.invalidateForPath(document.uri.fsPath);
      await FlarePreviewPanel.refreshCurrent(buildPreviewData);
      return;
    }

    if (isFlareHtmlDocument(document)) {
      await FlarePreviewPanel.refreshCurrent(buildPreviewData);
    }
  });

  const onDidCreate = dependencyWatcher.onDidCreate(onDependencyChanged);
  const onDidChange = dependencyWatcher.onDidChange(onDependencyChanged);
  const onDidDelete = dependencyWatcher.onDidDelete(onDependencyChanged);

  context.subscriptions.push(
    previewCommand,
    dependencyWatcher,
    onDidCreate,
    onDidChange,
    onDidDelete,
    onDidSave
  );
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
