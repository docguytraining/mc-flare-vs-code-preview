import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";
import { DismissalStore } from "../diagnostics/dismissalStore";

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
    private readonly projectResolver: FlareProjectResolver,
    private readonly dismissalStore: DismissalStore
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

    const sidecarDismissals = await this.dismissalStore
      .getDismissedVariables(projectContext, document.uri)
      .catch(() => [] as string[]);
    const ignoreList = new Set<string>([
      ...projectIgnoreList,
      ...sidecarDismissals
    ]);

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

      // Per-topic dismissal: write the variable name to the sidecar config
      // at `<projectRoot>/.vscode/flare-preview.json`. The topic file itself
      // is never modified; the sidecar is source-controllable and gives a
      // single place to audit dismissals across the project.
      const topicDismissAction = new vscode.CodeAction(
        `Never suggest '${match.variableName}' in this topic`,
        vscode.CodeActionKind.QuickFix
      );
      topicDismissAction.diagnostics = [diagnostic];
      topicDismissAction.command = {
        command: "flare.dismissVariableSuggestionInTopic",
        title: "Dismiss variable suggestion for this topic",
        arguments: [document.uri.toString(), match.variableName]
      };
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
  const ignoredValues = resolveIgnoredValues(variables, ignoreList);

  const map = new Map<string, string>();
  for (const [name, value] of variables.entries()) {
    const trimmed = value.trim();
    if (ignoredValues.has(trimmed)) {
      continue;
    }
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

/**
 * Resolves a set of ignored variable names to a set of ignored variable
 * *values*. This is the only filter that works correctly given how the
 * variables map holds each variable under both its qualified (`Set.Name`)
 * and bare (`Name`) form: if the user dismissed either form, we want the
 * underlying value to disappear from the reverse lookup so *neither* map
 * entry can surface in a match.
 *
 * Exported so the value-prefix completion provider can apply the same
 * filter by-value rather than by-name.
 */
export function resolveIgnoredValues(
  variables: Map<string, string>,
  ignoreList: Set<string>
): Set<string> {
  const result = new Set<string>();
  for (const ignoredName of ignoreList) {
    const directHit = variables.get(ignoredName);
    if (directHit !== undefined) {
      result.add(directHit.trim());
    }
    // Also resolve bare-form dismissals against every variable whose bare
    // name matches — in the rare case two different sets define the same
    // bare name, dismissing it suppresses both.
    if (!ignoredName.includes(".")) {
      for (const [candidateName, candidateValue] of variables.entries()) {
        const bare = candidateName.includes(".")
          ? candidateName.slice(candidateName.indexOf(".") + 1)
          : candidateName;
        if (bare === ignoredName) {
          result.add(candidateValue.trim());
        }
      }
    }
  }
  return result;
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
