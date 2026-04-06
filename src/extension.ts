import * as vscode from "vscode";
import { FlareProjectResolver } from "./core/flareProjectResolver";
import { FlarePreviewPanel } from "./preview/previewPanel";
import { resolveStylesheets } from "./flare/stylesheetResolver";
import { resolveVariables } from "./flare/variableResolver";
import { transformMadcapContent } from "./flare/madcapTransformPipeline";
import { disposeLogger, logError, logInfo } from "./core/logger";
import {
  DiagnosticEntry,
  FlareProjectContext,
  PreviewDiagnostics,
  StylesheetBundle,
  TransformResult,
  VariableResolutionResult
} from "./core/types";

const FLARE_PREVIEW_COMMAND = "flare.previewHtml";
const FLARE_FILE_EXTENSIONS = new Set([".htm", ".html"]);

export function activate(context: vscode.ExtensionContext): void {
  logInfo("MadCap Flare Preview extension activated.");
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
    const entries: DiagnosticEntry[] = [];
    const htmlContent = document.getText();

    let projectContext: FlareProjectContext | undefined;
    try {
      projectContext = await projectResolver.resolveForFile(document.uri);
    } catch (error) {
      logError("Project resolution failed", error);
      entries.push({
        code: "resolve-failed",
        severity: "error",
        message: "Failed to resolve Flare project context.",
        hint: "Check the Flare Preview output channel for details."
      });
    }

    if (!projectContext) {
      entries.push({
        code: "project-missing",
        severity: "warning",
        message: "No .flprj file was found by walking up from this topic.",
        hint: "Open this file from within a Flare project folder to enable variable and stylesheet resolution."
      });
    }

    let variableResult: VariableResolutionResult = {
      variables: new Map<string, string>(),
      unresolvedReferences: []
    };
    try {
      variableResult = await resolveVariables(htmlContent, projectContext);
    } catch (error) {
      logError("Variable resolution failed", error);
      entries.push({
        code: "resolve-failed",
        severity: "error",
        message: "Variable resolver threw an exception; variable substitution may be incomplete.",
        hint: "Check the Flare Preview output channel for details."
      });
    }

    for (const unresolved of variableResult.unresolvedReferences) {
      entries.push({
        code: "variable-unresolved",
        severity: "warning",
        message: `Unresolved variable '${unresolved}'.`,
        hint: "Define the variable in a .flvar file under the project VariableSets folder.",
        source: unresolved
      });
    }

    let stylesheetBundle: StylesheetBundle = {
      stylesheets: [],
      inlinedCss: [],
      missingStylesheets: []
    };
    try {
      stylesheetBundle = await resolveStylesheets(document, htmlContent, projectContext);
    } catch (error) {
      logError("Stylesheet resolution failed", error);
      entries.push({
        code: "resolve-failed",
        severity: "error",
        message: "Stylesheet resolver threw an exception; styling may be incomplete.",
        hint: "Check the Flare Preview output channel for details."
      });
    }

    for (const missingStylesheet of stylesheetBundle.missingStylesheets) {
      entries.push({
        code: "stylesheet-missing",
        severity: "warning",
        message: `Stylesheet could not be read: ${missingStylesheet}`,
        hint: "Verify the file exists and the referenced path is correct.",
        source: missingStylesheet
      });
    }

    let transformResult: TransformResult = {
      html: escapeHtmlContent(htmlContent),
      warnings: []
    };
    try {
      transformResult = await transformMadcapContent(htmlContent, {
        variables: variableResult.variables,
        projectContext,
        currentDocument: document.uri
      });
    } catch (error) {
      logError("MadCap transform pipeline failed", error);
      entries.push({
        code: "transform-failed",
        severity: "error",
        message: "MadCap transform pipeline failed; showing escaped source as fallback.",
        hint: "Check the Flare Preview output channel for details."
      });
    }

    for (const warning of transformResult.warnings) {
      entries.push(classifyTransformWarning(warning));
    }

    return {
      projectContext,
      variableResult,
      stylesheetBundle,
      transformResult,
      diagnostics: { entries }
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

  const onDependencyChanged = (uri: vscode.Uri): void => {
    projectResolver.invalidateForPath(uri.fsPath);
    FlarePreviewPanel.refreshCurrent(buildPreviewData);
  };

  const onDidSave = vscode.workspace.onDidSaveTextDocument((document) => {
    const autoRefresh = vscode.workspace
      .getConfiguration("flarePreview")
      .get<boolean>("autoRefreshOnSave", true);
    if (!autoRefresh) {
      return;
    }

    const lowerPath = document.uri.fsPath.toLowerCase();
    if (lowerPath.endsWith(".flprj") || lowerPath.endsWith(".flvar") || lowerPath.endsWith(".css")) {
      projectResolver.invalidateForPath(document.uri.fsPath);
      FlarePreviewPanel.refreshCurrent(buildPreviewData);
      return;
    }

    if (isFlareHtmlDocument(document)) {
      FlarePreviewPanel.refreshCurrent(buildPreviewData);
    }
  });

  const onDidChangeText = vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;
    if (!isFlareHtmlDocument(document)) {
      return;
    }
    FlarePreviewPanel.scheduleTypingRefresh(document.uri, buildPreviewData);
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
    onDidSave,
    onDidChangeText
  );
}

export function deactivate(): void {
  disposeLogger();
}

function escapeHtmlContent(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function classifyTransformWarning(warning: string): DiagnosticEntry {
  const base: Pick<DiagnosticEntry, "severity" | "source"> = {
    severity: "warning",
    source: warning
  };

  if (warning.toLowerCase().startsWith("unsupported madcap tag")) {
    return {
      ...base,
      code: "unsupported-tag",
      message: warning,
      hint: "The tag will render as a placeholder marker until a handler is added."
    };
  }

  if (warning.toLowerCase().includes("snippet")) {
    return {
      ...base,
      code: "snippet-missing",
      message: warning,
      hint: "Verify the snippet path relative to the topic or project root."
    };
  }

  if (warning.toLowerCase().includes("variable")) {
    return {
      ...base,
      code: "variable-unresolved",
      message: warning,
      hint: "Add the variable to a .flvar file or correct the reference."
    };
  }

  return {
    ...base,
    code: "transform-failed",
    message: warning
  };
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
