import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";

const SUGGESTION_CODE = "flare.variable-replacement-suggested";
const DIAGNOSTIC_SOURCE = "flare";

interface SuggestionMatch {
  range: vscode.Range;
  literal: string;
  variableName: string;
  variableValue: string;
}

/**
 * Scans a topic for literal text that matches the value of a defined Flare
 * variable and surfaces each match as an Information diagnostic with a code
 * action that rewrites the literal to a `<MadCap:variable>` reference.
 *
 * Controlled by `flarePreview.suggestVariableReplacements`. Literals shorter
 * than `flarePreview.variableReplacementMinLength` are ignored to cut down on
 * noise for short words.
 */
export class VariableSuggestionEngine implements vscode.CodeActionProvider {
  public static readonly diagnosticCode = SUGGESTION_CODE;

  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly projectResolver: FlareProjectResolver
  ) {}

  public async refresh(document: vscode.TextDocument): Promise<void> {
    if (!isFlareTopic(document)) {
      return;
    }

    const config = vscode.workspace.getConfiguration("flarePreview");
    const enabled = config.get<boolean>("suggestVariableReplacements", true);
    if (!enabled) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const minLength = Math.max(
      2,
      config.get<number>("variableReplacementMinLength", 4)
    );
    const projectIgnoreList = (config.get<string[]>("suggestionIgnoreVariables", []) ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const documentIgnoreList = readDocumentIgnoreMarkers(document.getText());
    const ignoreList = new Set([...projectIgnoreList, ...documentIgnoreList]);

    let projectContext;
    try {
      projectContext = await this.projectResolver.resolveForFile(document.uri);
    } catch {
      this.diagnostics.delete(document.uri);
      return;
    }
    if (!projectContext) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const variableResult = await resolveVariables(document.getText(), projectContext);
    if (variableResult.variables.size === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const valueToName = buildReverseLookup(variableResult.variables, minLength, ignoreList);
    if (valueToName.size === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const matches = findMatches(document, valueToName);
    if (matches.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const entries: vscode.Diagnostic[] = matches.map((match) => {
      const diagnostic = new vscode.Diagnostic(
        match.range,
        `'${match.literal}' matches the value of Flare variable '${match.variableName}'. Consider replacing it with a <MadCap:variable> reference.`,
        vscode.DiagnosticSeverity.Information
      );
      diagnostic.code = SUGGESTION_CODE;
      diagnostic.source = DIAGNOSTIC_SOURCE;
      return diagnostic;
    });

    this.diagnostics.set(document.uri, entries);
  }

  public clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== SUGGESTION_CODE) {
        continue;
      }
      const literal = document.getText(diagnostic.range);
      const match = parseMessage(diagnostic.message);
      if (!match) {
        continue;
      }
      const action = new vscode.CodeAction(
        `Replace with <MadCap:variable name="${match.variableName}" />`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        diagnostic.range,
        `<MadCap:variable name="${match.variableName}" />`
      );
      action.edit = edit;
      actions.push(action);

      // Per-topic dismissal: insert an inline `<!-- flare:no-suggest X -->`
      // marker so this variable stops triggering in *this* topic only.
      // Lives in the file so it's reviewable, source-controlled, and
      // visible to teammates without sharing settings.
      const topicDismissAction = new vscode.CodeAction(
        `Never suggest '${match.variableName}' in this topic`,
        vscode.CodeActionKind.QuickFix
      );
      topicDismissAction.diagnostics = [diagnostic];
      topicDismissAction.edit = buildDismissMarkerEdit(document, match.variableName);
      actions.push(topicDismissAction);

      // Project-wide dismissal: persist the variable name to the workspace
      // setting so it never triggers anywhere in this project. Use this for
      // variables that are universally noisy across all topics.
      const projectDismissAction = new vscode.CodeAction(
        `Never suggest '${match.variableName}' anywhere in this project`,
        vscode.CodeActionKind.QuickFix
      );
      projectDismissAction.diagnostics = [diagnostic];
      projectDismissAction.command = {
        command: "flare.dismissVariableSuggestion",
        title: "Dismiss Flare variable suggestion project-wide",
        arguments: [match.variableName]
      };
      actions.push(projectDismissAction);

      // Keep parameter alive for tooling without leaking state.
      void literal;
    }
    return actions;
  }
}

function buildReverseLookup(
  variables: Map<string, string>,
  minLength: number,
  ignoreList: Set<string>
): Map<string, string> {
  // Case-sensitive: keys are the exact (trimmed) variable value. Real Flare
  // variable values carry intentional capitalization, and matching them
  // case-sensitively is the easiest way to keep generic English words like
  // "user" or "page" from triggering false suggestions when a variable also
  // happens to share a lowercase form.
  const map = new Map<string, string>();
  for (const [name, value] of variables.entries()) {
    if (ignoreList.has(name)) {
      continue;
    }
    // Allow ignoring by either the qualified `<set>.<var>` form or the bare
    // form. Strip the leading set prefix and check both.
    const bareName = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
    if (ignoreList.has(bareName)) {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      continue;
    }
    // Skip values that are pure numbers or punctuation; those would generate noise.
    if (!/[A-Za-z]/.test(trimmed)) {
      continue;
    }
    if (!map.has(trimmed)) {
      map.set(trimmed, name);
    }
  }
  return map;
}

function findMatches(
  document: vscode.TextDocument,
  valueToName: Map<string, string>
): SuggestionMatch[] {
  const text = document.getText();
  const matches: SuggestionMatch[] = [];
  const skipRanges = computeSkipRanges(text);

  for (const [exactValue, name] of valueToName.entries()) {
    // Case-sensitive match (no `i` flag) and word-bounded so values that
    // start/end with a word character don't accidentally match a substring
    // inside a longer word.
    const escaped = escapeRegExp(exactValue);
    const leftBoundary = /^\w/.test(exactValue) ? "\\b" : "";
    const rightBoundary = /\w$/.test(exactValue) ? "\\b" : "";
    const regex = new RegExp(`${leftBoundary}${escaped}${rightBoundary}`, "g");

    let match = regex.exec(text);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isInsideSkipRange(start, end, skipRanges)) {
        matches.push({
          range: new vscode.Range(document.positionAt(start), document.positionAt(end)),
          literal: match[0],
          variableName: name,
          variableValue: exactValue
        });
      }
      match = regex.exec(text);
    }
  }

  // Deduplicate overlapping matches: prefer the longer one.
  matches.sort((a, b) => a.range.start.compareTo(b.range.start));
  const result: SuggestionMatch[] = [];
  for (const match of matches) {
    const previous = result[result.length - 1];
    if (previous && !previous.range.end.isBeforeOrEqual(match.range.start)) {
      if (match.literal.length > previous.literal.length) {
        result[result.length - 1] = match;
      }
      continue;
    }
    result.push(match);
  }
  return result;
}

type Range = { start: number; end: number };

const SKIP_PATTERNS: RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /<MadCap:variable\b[^>]*\/?>/gi,
  /<MadCap:[A-Za-z0-9_-]+\b[^>]*\/?>/gi,
  /\s[a-zA-Z:][a-zA-Z0-9:_-]*\s*=\s*"[^"]*"/g,
  /\s[a-zA-Z:][a-zA-Z0-9:_-]*\s*=\s*'[^']*'/g
];

function computeSkipRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of SKIP_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      match = pattern.exec(text);
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) {
    return ranges;
  }
  const merged: Range[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1];
    const current = ranges[i];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function isInsideSkipRange(start: number, end: number, ranges: Range[]): boolean {
  // Binary search would be nicer but ranges are small per topic.
  for (const range of ranges) {
    if (range.start > end) {
      return false;
    }
    if (start >= range.start && end <= range.end) {
      return true;
    }
  }
  return false;
}

const NO_SUGGEST_COMMENT_REGEX = /<!--\s*flare:no-suggest\s+([^>]*?)\s*-->/gi;

/**
 * Reads inline `<!-- flare:no-suggest VariableName[, VariableName2] -->`
 * markers from a topic. Multiple comments are allowed; comma-separated
 * names inside a single comment are also supported. The result is the union
 * of every name found.
 */
export function readDocumentIgnoreMarkers(text: string): string[] {
  const found: string[] = [];
  NO_SUGGEST_COMMENT_REGEX.lastIndex = 0;
  let match = NO_SUGGEST_COMMENT_REGEX.exec(text);
  while (match) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (name.length > 0) {
        found.push(name);
      }
    }
    match = NO_SUGGEST_COMMENT_REGEX.exec(text);
  }
  return found;
}

/**
 * Computes a `WorkspaceEdit` that inserts a `<!-- flare:no-suggest X -->`
 * marker into the topic in a sensible spot: just after the opening `<body>`
 * tag if one exists, otherwise at the very top of the document. The marker
 * goes on its own line so it doesn't interfere with surrounding markup.
 */
export function buildDismissMarkerEdit(
  document: vscode.TextDocument,
  variableName: string
): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const text = document.getText();
  const bodyMatch = /<body\b[^>]*>/i.exec(text);
  let insertOffset = 0;
  let leadingNewline = "";
  if (bodyMatch) {
    insertOffset = bodyMatch.index + bodyMatch[0].length;
    leadingNewline = "\n  ";
  } else {
    insertOffset = 0;
    leadingNewline = "";
  }
  const insertPosition = document.positionAt(insertOffset);
  const marker = `${leadingNewline}<!-- flare:no-suggest ${variableName} -->`;
  edit.insert(document.uri, insertPosition, marker);
  return edit;
}

function parseMessage(message: string): { literal: string; variableName: string } | undefined {
  const match = /'([^']+)' matches the value of Flare variable '([^']+)'/.exec(message);
  if (!match) {
    return undefined;
  }
  return { literal: match[1], variableName: match[2] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
