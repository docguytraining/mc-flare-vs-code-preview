import * as vscode from "vscode";
import { FlareProjectResolver } from "./core/flareProjectResolver";
import { FlarePreviewPanel } from "./preview/previewPanel";
import { resolveStylesheets } from "./flare/stylesheetResolver";
import { resolveVariables } from "./flare/variableResolver";
import { transformMadcapContent } from "./flare/madcapTransformPipeline";
import { TopicIndex } from "./flare/topicIndex";
import { disposeLogger, logError, logInfo } from "./core/logger";
import { VariableInlayHintsProvider } from "./language/variableInlayHintsProvider";
import { VariableCompletionProvider } from "./language/variableCompletionProvider";
import { VariableSuggestionEngine } from "./language/variableSuggestionEngine";
import { XrefCompletionProvider } from "./language/xrefCompletionProvider";
import { LinkValidator } from "./diagnostics/linkValidator";
import { DismissalStore } from "./diagnostics/dismissalStore";
import { registerInsertXrefCommand } from "./commands/insertXrefCommand";
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
const HTML_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: "html", scheme: "file" },
  { pattern: "**/*.{htm,html}", scheme: "file" }
];
const AUTHORING_DEBOUNCE_MS = 400;

export function activate(context: vscode.ExtensionContext): void {
  logInfo("MadCap Flare Preview extension activated.");
  const projectResolver = new FlareProjectResolver();
  const topicIndex = new TopicIndex();
  const dismissalStore = new DismissalStore();
  const suggestionDiagnostics = vscode.languages.createDiagnosticCollection("flare-variables");
  const linkDiagnostics = vscode.languages.createDiagnosticCollection("flare-links");
  const suggestionEngine = new VariableSuggestionEngine(suggestionDiagnostics, projectResolver, dismissalStore);
  const linkValidator = new LinkValidator(linkDiagnostics, projectResolver);
  const authoringTimers = new Map<string, NodeJS.Timeout>();

  const scheduleAuthoringValidation = (document: vscode.TextDocument): void => {
    if (!isFlareHtmlDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    const existing = authoringTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      authoringTimers.delete(key);
      void suggestionEngine.refresh(document).catch((error) => logError("Suggestion engine failed", error));
      void linkValidator.validate(document).catch((error) => logError("Link validator failed", error));
    }, AUTHORING_DEBOUNCE_MS);
    authoringTimers.set(key, timer);
  };

  const runAuthoringValidationImmediately = (document: vscode.TextDocument): void => {
    if (!isFlareHtmlDocument(document)) {
      return;
    }
    void suggestionEngine.refresh(document).catch((error) => logError("Suggestion engine failed", error));
    void linkValidator.validate(document).catch((error) => logError("Link validator failed", error));
  };

  for (const document of vscode.workspace.textDocuments) {
    runAuthoringValidationImmediately(document);
  }

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
    scheduleAuthoringValidation(document);
  });

  const onDidOpen = vscode.workspace.onDidOpenTextDocument((document) => {
    runAuthoringValidationImmediately(document);
    void detectStaleDismissalsForDocument(document);
  });

  const onDidClose = vscode.workspace.onDidCloseTextDocument((document) => {
    suggestionEngine.clear(document.uri);
    linkValidator.clear(document.uri);
    const key = document.uri.toString();
    const timer = authoringTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      authoringTimers.delete(key);
    }
  });

  const onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("flarePreview.suggestVariableReplacements") ||
      event.affectsConfiguration("flarePreview.variableReplacementMinLength") ||
      event.affectsConfiguration("flarePreview.suggestionIgnoreVariables") ||
      event.affectsConfiguration("flarePreview.validateLinks")
    ) {
      for (const document of vscode.workspace.textDocuments) {
        runAuthoringValidationImmediately(document);
      }
    }
  });

  const topicWatcher = vscode.workspace.createFileSystemWatcher("**/*.{htm,html}");
  const onTopicChanged = (uri: vscode.Uri): void => {
    topicIndex.invalidateForPath(uri.fsPath);
  };
  const onTopicCreated = topicWatcher.onDidCreate(onTopicChanged);
  const onTopicEdited = topicWatcher.onDidChange(onTopicChanged);
  const onTopicDeleted = topicWatcher.onDidDelete(onTopicChanged);

  // When a topic is renamed inside VS Code (Explorer F2, drag-drop, refactor),
  // migrate any sidecar dismissals so they travel with the file. External
  // renames (git mv, terminal mv, file manager) don't surface here; the
  // resulting orphan entries are handled by the stale-entry detector.
  const onDidRename = vscode.workspace.onDidRenameFiles(async (event) => {
    for (const { oldUri, newUri } of event.files) {
      if (!isFlareHtmlPath(oldUri.fsPath) && !isFlareHtmlPath(newUri.fsPath)) {
        continue;
      }
      const projectContext = await projectResolver
        .resolveForFile(newUri)
        .catch(() => undefined);
      if (!projectContext) {
        continue;
      }
      try {
        await dismissalStore.renameTopic(projectContext, oldUri, newUri);
      } catch (error) {
        logError(`Failed to migrate dismissal entry on rename of ${oldUri.fsPath}`, error);
      }
      topicIndex.invalidateForPath(oldUri.fsPath);
      topicIndex.invalidateForPath(newUri.fsPath);
    }
  });

  // Detect stale dismissal entries per project. A "stale entry" is a
  // dismissal that points at a topic file which no longer exists on disk
  // (most commonly because the file was renamed/moved outside VS Code so
  // the rename handler above never saw it). Each project gets scanned at
  // most once per activation; the set is closed over so repeat opens in
  // the same session are cheap.
  const scannedProjects = new Set<string>();
  const detectStaleDismissalsForDocument = async (document: vscode.TextDocument): Promise<void> => {
    if (!isFlareHtmlDocument(document)) {
      return;
    }
    const projectContext = await projectResolver.resolveForFile(document.uri).catch(() => undefined);
    if (!projectContext) {
      return;
    }
    if (scannedProjects.has(projectContext.projectRoot.fsPath)) {
      return;
    }
    scannedProjects.add(projectContext.projectRoot.fsPath);
    await dismissalStore.detectStaleEntries(projectContext).catch(() => undefined);
  };

  // Scan any topic that's already open at activation time.
  for (const document of vscode.workspace.textDocuments) {
    void detectStaleDismissalsForDocument(document);
  }

  const inlayHintsRegistration = vscode.languages.registerInlayHintsProvider(
    HTML_DOCUMENT_SELECTOR,
    new VariableInlayHintsProvider(projectResolver)
  );

  const variableCompletionRegistration = vscode.languages.registerCompletionItemProvider(
    HTML_DOCUMENT_SELECTOR,
    new VariableCompletionProvider(projectResolver, dismissalStore),
    '"',
    "'"
  );

  const xrefCompletionRegistration = vscode.languages.registerCompletionItemProvider(
    HTML_DOCUMENT_SELECTOR,
    new XrefCompletionProvider(projectResolver, topicIndex),
    '"',
    "'",
    "#",
    "/"
  );

  const codeActionRegistration = vscode.languages.registerCodeActionsProvider(
    HTML_DOCUMENT_SELECTOR,
    suggestionEngine,
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  const insertXrefRegistration = registerInsertXrefCommand(projectResolver, topicIndex);

  const dismissTopicSuggestionRegistration = vscode.commands.registerCommand(
    "flare.dismissVariableSuggestionInTopic",
    async (topicUriString?: string, variableName?: string) => {
      if (typeof topicUriString !== "string" || typeof variableName !== "string") {
        return;
      }
      const topicUri = vscode.Uri.parse(topicUriString);
      const projectContext = await projectResolver.resolveForFile(topicUri).catch(() => undefined);
      if (!projectContext) {
        vscode.window.showWarningMessage(
          "Flare: cannot dismiss this suggestion because no .flprj project was found above the topic."
        );
        return;
      }
      try {
        await dismissalStore.dismissForTopic(projectContext, topicUri, variableName);
      } catch (error) {
        logError("Failed to record per-topic dismissal", error);
        vscode.window.showErrorMessage(
          `Flare: failed to write dismissal to .vscode/flare-preview.json (${String(error)})`
        );
        return;
      }
      let document: vscode.TextDocument | undefined;
      try {
        document = await vscode.workspace.openTextDocument(topicUri);
      } catch {
        document = undefined;
      }
      if (document) {
        runAuthoringValidationImmediately(document);
      }
    }
  );

  const dismissSuggestionRegistration = vscode.commands.registerCommand(
    "flare.dismissVariableSuggestion",
    async (variableName?: string) => {
      if (typeof variableName !== "string" || variableName.length === 0) {
        return;
      }
      const config = vscode.workspace.getConfiguration("flarePreview");
      const current = config.get<string[]>("suggestionIgnoreVariables", []) ?? [];
      if (current.includes(variableName)) {
        return;
      }
      const next = [...current, variableName].sort();
      try {
        await config.update(
          "suggestionIgnoreVariables",
          next,
          vscode.ConfigurationTarget.Workspace
        );
      } catch {
        // Fall back to global if no workspace is open.
        await config.update(
          "suggestionIgnoreVariables",
          next,
          vscode.ConfigurationTarget.Global
        );
      }
      for (const document of vscode.workspace.textDocuments) {
        runAuthoringValidationImmediately(document);
      }
      logInfo(`Added '${variableName}' to suggestionIgnoreVariables.`);
    }
  );

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
    onDidChangeText,
    onDidOpen,
    onDidClose,
    onDidChangeConfiguration,
    topicWatcher,
    onTopicCreated,
    onTopicEdited,
    onTopicDeleted,
    inlayHintsRegistration,
    variableCompletionRegistration,
    xrefCompletionRegistration,
    codeActionRegistration,
    insertXrefRegistration,
    dismissTopicSuggestionRegistration,
    dismissSuggestionRegistration,
    onDidRename,
    suggestionDiagnostics,
    linkDiagnostics,
    {
      dispose: () => {
        for (const timer of authoringTimers.values()) {
          clearTimeout(timer);
        }
        authoringTimers.clear();
      }
    }
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
  return isFlareHtmlPath(document.uri.fsPath);
}

function isFlareHtmlPath(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  for (const extension of FLARE_FILE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}
