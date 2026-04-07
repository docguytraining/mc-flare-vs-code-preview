import * as vscode from "vscode";
import { FlareProjectResolver } from "./core/flareProjectResolver";
import { FlarePreviewPanel } from "./preview/previewPanel";
import { resolveStylesheets } from "./flare/stylesheetResolver";
import { resolveVariables } from "./flare/variableResolver";
import { transformMadcapContent } from "./flare/madcapTransformPipeline";
import { TopicIndex } from "./flare/topicIndex";
import { ConditionTagIndex } from "./flare/conditionTagIndex";
import { discoverTargets, SHOW_EVERYTHING_TARGET_ID, TargetEntry } from "./flare/targetIndex";
import { parseTargetExpression } from "./flare/conditionExpression";
import { ConditionDiagnosticProvider } from "./diagnostics/conditionDiagnosticProvider";
import { ConditionGutterDecorations } from "./diagnostics/conditionGutterDecorations";
import { ConditionCompletionProvider } from "./language/conditionCompletionProvider";
import { registerRenameReferencesHandler } from "./commands/renameReferencesHandler";
import { registerRenameConditionTagCommand } from "./commands/renameConditionTagCommand";
import { registerValidateAllTopicsCommand } from "./commands/validateAllTopicsCommand";
import { disposeLogger, logError, logInfo, showLogChannel } from "./core/logger";
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
  PreviewConditionInventory,
  PreviewDiagnostics,
  PreviewTargetInfo,
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
  const conditionTagIndex = new ConditionTagIndex();
  const dismissalStore = new DismissalStore();
  const suggestionDiagnostics = vscode.languages.createDiagnosticCollection("flare-variables");
  const linkDiagnostics = vscode.languages.createDiagnosticCollection("flare-links");
  const conditionDiagnostics = vscode.languages.createDiagnosticCollection("flare-conditions");
  const suggestionEngine = new VariableSuggestionEngine(suggestionDiagnostics, projectResolver, dismissalStore);
  const linkValidator = new LinkValidator(linkDiagnostics, projectResolver);
  const conditionDiagnosticProvider = new ConditionDiagnosticProvider(
    conditionDiagnostics,
    projectResolver,
    conditionTagIndex
  );
  const conditionGutter = new ConditionGutterDecorations(projectResolver, conditionTagIndex);
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
      void conditionDiagnosticProvider
        .validate(document)
        .catch((error) => logError("Condition diagnostic provider failed", error));
    }, AUTHORING_DEBOUNCE_MS);
    authoringTimers.set(key, timer);
  };

  const runAuthoringValidationImmediately = (document: vscode.TextDocument): void => {
    if (!isFlareHtmlDocument(document)) {
      return;
    }
    void suggestionEngine.refresh(document).catch((error) => logError("Suggestion engine failed", error));
    void linkValidator.validate(document).catch((error) => logError("Link validator failed", error));
    void conditionDiagnosticProvider
      .validate(document)
      .catch((error) => logError("Condition diagnostic provider failed", error));
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
    conditions: PreviewConditionInventory;
    availableTargets: PreviewTargetInfo[];
    activeTargetId: string;
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

    // Resolve the active target's condition expression so the transform
    // pipeline can hide elements that the target excludes. The list of
    // available targets is also returned to the preview panel so it can
    // render its picker.
    let availableTargets: TargetEntry[] = [];
    let activeTargetId = SHOW_EVERYTHING_TARGET_ID;
    if (projectContext) {
      try {
        availableTargets = await discoverTargets(projectContext);
      } catch (error) {
        logError("Target discovery failed", error);
      }
      try {
        const persisted = await dismissalStore.getPreviewTarget(projectContext);
        if (persisted && availableTargets.some((target) => target.id === persisted)) {
          activeTargetId = persisted;
        }
      } catch (error) {
        logError("Reading persisted preview target failed", error);
      }
    }
    const activeTarget =
      availableTargets.find((target) => target.id === activeTargetId) ??
      availableTargets[0];
    const conditionExpression = parseTargetExpression(activeTarget?.expression);
    const showConditionBadges = vscode.workspace
      .getConfiguration("flarePreview")
      .get<boolean>("showConditionBadges", false);

    const collectedConditions = {
      elementConditionCounts: new Map<string, number>(),
      snippetConditionCounts: new Map<string, number>(),
      hiddenCount: 0
    };

    let transformResult: TransformResult = {
      html: escapeHtmlContent(htmlContent),
      warnings: []
    };
    try {
      transformResult = await transformMadcapContent(htmlContent, {
        variables: variableResult.variables,
        projectContext,
        currentDocument: document.uri,
        conditionExpression,
        showConditionBadges,
        collectedConditions
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
      diagnostics: { entries },
      conditions: collectedConditions,
      availableTargets: availableTargets.map((target) => ({
        id: target.id,
        displayName: target.displayName,
        expression: target.expression
      })),
      activeTargetId: activeTarget?.id ?? SHOW_EVERYTHING_TARGET_ID
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

  const dependencyWatcher = vscode.workspace.createFileSystemWatcher("**/*.{flprj,flvar,css,flcts,fltar}");

  const onDependencyChanged = (uri: vscode.Uri): void => {
    projectResolver.invalidateForPath(uri.fsPath);
    conditionTagIndex.invalidateForPath(uri.fsPath);
    conditionGutter.refreshAll();
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
    if (
      lowerPath.endsWith(".flprj") ||
      lowerPath.endsWith(".flvar") ||
      lowerPath.endsWith(".css") ||
      lowerPath.endsWith(".flcts") ||
      lowerPath.endsWith(".fltar")
    ) {
      projectResolver.invalidateForPath(document.uri.fsPath);
      conditionTagIndex.invalidateForPath(document.uri.fsPath);
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
  // the same session are cheap. When stale entries are found, surface a
  // one-shot warning notification with a "Show details" button that opens
  // the output channel — the raw warning line is still written to the
  // channel for audit either way.
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
    const stale = await dismissalStore
      .detectStaleEntries(projectContext)
      .catch(() => [] as string[]);
    if (stale.length === 0) {
      return;
    }

    const message = stale.length === 1
      ? `Flare: 1 stale dismissal entry in .vscode/flare-preview.json (${stale[0]} no longer exists).`
      : `Flare: ${stale.length} stale dismissal entries in .vscode/flare-preview.json (topic paths no longer exist).`;
    const choice = await vscode.window.showWarningMessage(message, "Show details");
    if (choice === "Show details") {
      showLogChannel();
    }
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
  const validateAllTopicsRegistration = registerValidateAllTopicsCommand(
    projectResolver,
    linkValidator
  );
  const renameReferencesRegistration = registerRenameReferencesHandler(projectResolver);
  const renameConditionTagRegistration = registerRenameConditionTagCommand(
    projectResolver,
    conditionTagIndex
  );

  const conditionCompletionRegistration = vscode.languages.registerCompletionItemProvider(
    HTML_DOCUMENT_SELECTOR,
    new ConditionCompletionProvider(projectResolver, conditionTagIndex),
    '"',
    "'",
    ","
  );

  const pickPreviewTargetRegistration = vscode.commands.registerCommand(
    "flare.pickPreviewTarget",
    async (resource?: vscode.Uri) => {
      const document =
        (await resolveDocument(resource).catch(() => undefined)) ??
        vscode.window.activeTextEditor?.document;
      if (!document) {
        vscode.window.showInformationMessage(
          "Open a Flare topic before picking a preview target."
        );
        return;
      }
      const projectContext = await projectResolver
        .resolveForFile(document.uri)
        .catch(() => undefined);
      if (!projectContext) {
        vscode.window.showWarningMessage(
          "Flare: cannot pick a target because no .flprj project was found above this topic."
        );
        return;
      }
      const targets = await discoverTargets(projectContext);
      const items = targets.map((target) => ({
        label: target.displayName,
        description:
          target.id === SHOW_EVERYTHING_TARGET_ID
            ? "Render every conditional element"
            : target.expression
              ? target.expression
              : "(no condition expression)",
        targetId: target.id
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "Flare Preview Target",
        placeHolder: "Pick the build target to preview"
      });
      if (!picked) {
        return;
      }
      try {
        await dismissalStore.setPreviewTarget(projectContext, picked.targetId);
      } catch (error) {
        logError("Failed to persist preview target", error);
      }
      FlarePreviewPanel.refreshCurrent(buildPreviewData);
    }
  );

  const openConditionInTopicRegistration = vscode.commands.registerCommand(
    "flare.openConditionInTopic",
    async (topicUri?: vscode.Uri, tagName?: string) => {
      if (!topicUri || typeof tagName !== "string" || tagName.length === 0) {
        return;
      }
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(topicUri);
      } catch (error) {
        logError(`Failed to open topic for condition jump: ${String(error)}`, error);
        return;
      }
      const occurrences = findConditionOccurrences(document, tagName);
      if (occurrences.length === 0) {
        vscode.window.showInformationMessage(
          `Flare: '${tagName}' is no longer present in this topic.`
        );
        return;
      }
      const jumpTo = async (index: number): Promise<void> => {
        const position = occurrences[index];
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          preview: false,
          selection: new vscode.Range(position, position)
        });
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      };
      if (occurrences.length === 1) {
        await jumpTo(0);
        return;
      }
      const items = occurrences.map((position, index) => {
        const lineText = document.lineAt(position.line).text.trim();
        return {
          label: `Line ${position.line + 1}`,
          description: lineText.length > 80 ? `${lineText.slice(0, 80)}…` : lineText,
          index
        };
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: `Flare: '${tagName}' has ${occurrences.length} occurrences`,
        placeHolder: "Pick the occurrence to jump to"
      });
      if (picked) {
        await jumpTo(picked.index);
      }
    }
  );

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
    conditionCompletionRegistration,
    codeActionRegistration,
    insertXrefRegistration,
    validateAllTopicsRegistration,
    renameReferencesRegistration,
    renameConditionTagRegistration,
    pickPreviewTargetRegistration,
    openConditionInTopicRegistration,
    dismissTopicSuggestionRegistration,
    dismissSuggestionRegistration,
    onDidRename,
    suggestionDiagnostics,
    linkDiagnostics,
    conditionDiagnostics,
    conditionGutter,
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

/**
 * Walks the source text of a topic document looking for the given condition
 * tag inside `MadCap:conditions=` or `MadCap:conditionTagExpression=`
 * attributes. Returns the position of the start of each matching attribute
 * value (in document order). Used by `flare.openConditionInTopic` to back the
 * clickable rows in the preview's Conditions section.
 */
function findConditionOccurrences(
  document: vscode.TextDocument,
  tagName: string
): vscode.Position[] {
  const text = document.getText();
  const regex =
    /\b(?:MadCap:conditions|MadCap:conditionTagExpression)\s*=\s*(["'])([^"']*)\1/gi;
  const tagRegex = new RegExp(`(?<![\\w.-])${escapeRegex(tagName)}(?![\\w.-])`);
  const positions: vscode.Position[] = [];
  let match = regex.exec(text);
  while (match) {
    const value = match[2] ?? "";
    if (tagRegex.test(value)) {
      const valueStart = match.index + match[0].length - 1 - value.length;
      positions.push(document.positionAt(valueStart));
    }
    match = regex.exec(text);
  }
  return positions;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
