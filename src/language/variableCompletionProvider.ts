import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";
import { readDocumentIgnoreMarkers } from "./variableSuggestionEngine";

const MAX_PREFIX_SCAN = 60;
const MIN_PREFIX_LENGTH_FOR_VALUE_COMPLETION = 3;

/**
 * Completion provider for Flare variables. Two modes:
 *
 *  1. **Name-attribute mode** — triggered inside `<MadCap:variable name="…">`.
 *     Lists every variable in the project so authors can pick the canonical
 *     name without leaving the editor.
 *
 *  2. **Value-prefix mode** — triggered while typing prose (anywhere outside
 *     a tag). When the typed prefix matches the start of a variable's value
 *     (e.g. typing "Trust Pro…" and the project defines a variable equal to
 *     "Trust Protection Foundation"), the completion list offers to replace
 *     the typed prefix with `<MadCap:variable name="…" />`. Acceptance does
 *     a single edit, so authors can stay in flow.
 *
 * Variables on the workspace `flarePreview.suggestionIgnoreVariables` list
 * are excluded from value-prefix completions.
 */
export class VariableCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(private readonly projectResolver: FlareProjectResolver) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }

    let projectContext;
    try {
      projectContext = await this.projectResolver.resolveForFile(document.uri);
    } catch {
      return undefined;
    }
    if (!projectContext) {
      return undefined;
    }

    const variableResult = await resolveVariables(document.getText(), projectContext);
    if (variableResult.variables.size === 0) {
      return undefined;
    }

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    if (isInsideVariableNameAttribute(linePrefix)) {
      return this.buildNameCompletions(variableResult.variables);
    }

    return this.buildValuePrefixCompletions(document, position, linePrefix, variableResult.variables);
  }

  private buildNameCompletions(variables: Map<string, string>): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    for (const [name, value] of variables.entries()) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
      item.detail = truncate(value, 80);
      item.documentation = new vscode.MarkdownString(`**${name}**\n\n${escapeMarkdown(value)}`);
      item.sortText = name;
      item.insertText = name;
      item.filterText = name;
      items.push(item);
    }
    return items;
  }

  private buildValuePrefixCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string,
    variables: Map<string, string>
  ): vscode.CompletionItem[] | undefined {
    // We only want to fire in flowing prose, not inside or right next to an
    // HTML tag. Walk backward from the cursor and bail if the most recent
    // angle bracket we see is an opening `<`.
    if (isInsideTag(linePrefix)) {
      return undefined;
    }

    const prefixInfo = extractValuePrefix(linePrefix, position);
    if (!prefixInfo) {
      return undefined;
    }

    const projectIgnore = readProjectIgnoreList();
    const documentIgnore = new Set(readDocumentIgnoreMarkers(document.getText()));
    const ignoreList = new Set([...projectIgnore, ...documentIgnore]);
    // Case-sensitive prefix match against the variable values, mirroring the
    // case-sensitivity of the suggestion engine. Authors who type "Trust Pro"
    // get "Trust Protection Foundation" suggested; "trust pro" gets nothing.
    const exactPrefix = prefixInfo.text;

    const items: vscode.CompletionItem[] = [];
    const seenVariableNames = new Set<string>();
    for (const [name, value] of variables.entries()) {
      if (seenVariableNames.has(name)) {
        continue;
      }
      if (ignoreList.has(name)) {
        continue;
      }
      const bareName = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
      if (ignoreList.has(bareName)) {
        continue;
      }
      const trimmedValue = value.trim();
      if (trimmedValue.length < exactPrefix.length) {
        continue;
      }
      if (!trimmedValue.startsWith(exactPrefix)) {
        continue;
      }
      seenVariableNames.add(name);

      const replaceRange = new vscode.Range(prefixInfo.start, position);
      const item = new vscode.CompletionItem(
        { label: trimmedValue, description: name },
        vscode.CompletionItemKind.Snippet
      );
      item.detail = `Insert <MadCap:variable name="${name}" />`;
      item.documentation = new vscode.MarkdownString(
        `Replaces the typed text with the canonical Flare variable reference.\n\n` +
        `**${name}** = ${escapeMarkdown(trimmedValue)}`
      );
      item.insertText = `<MadCap:variable name="${name}" />`;
      item.filterText = trimmedValue;
      item.range = replaceRange;
      item.sortText = `0_${trimmedValue}`;
      items.push(item);
    }

    return items.length > 0 ? items : undefined;
  }
}

function isInsideVariableNameAttribute(linePrefix: string): boolean {
  return /<MadCap:variable\b[^>]*\bname\s*=\s*["'][^"']*$/i.test(linePrefix);
}

function isInsideTag(linePrefix: string): boolean {
  // Walk back through the prefix; if we find an unmatched `<` before we find
  // a `>`, we're inside a tag. This deliberately ignores complete tags like
  // `<p>` that have already closed.
  for (let i = linePrefix.length - 1; i >= 0; i -= 1) {
    const ch = linePrefix.charAt(i);
    if (ch === ">") {
      return false;
    }
    if (ch === "<") {
      return true;
    }
  }
  return false;
}

interface PrefixInfo {
  text: string;
  start: vscode.Position;
}

/**
 * Walks backward from the cursor to collect the "prose prefix" being typed.
 * Stops at any character that can't be part of flowing text (HTML brackets,
 * quote marks, newlines). Returns undefined when the prefix is too short to
 * justify a value-prefix completion.
 */
function extractValuePrefix(linePrefix: string, position: vscode.Position): PrefixInfo | undefined {
  const start = Math.max(0, linePrefix.length - MAX_PREFIX_SCAN);
  let cut = linePrefix.length;
  for (let i = linePrefix.length - 1; i >= start; i -= 1) {
    const ch = linePrefix.charAt(i);
    if (ch === "<" || ch === ">" || ch === '"' || ch === "'") {
      cut = i + 1;
      break;
    }
    cut = i;
  }
  let text = linePrefix.slice(cut).replace(/^\s+/, "");
  // If we ate the entire prefix, the start should be cut + leading-trim count.
  const leadingTrimmed = linePrefix.slice(cut).length - text.length;
  if (text.length < MIN_PREFIX_LENGTH_FOR_VALUE_COMPLETION) {
    return undefined;
  }
  if (!/[A-Za-z]/.test(text)) {
    return undefined;
  }
  // Don't trigger if the prefix ends in pure whitespace — VS Code already
  // shows completions on word characters; whitespace usually means "I just
  // finished a word".
  if (/\s$/.test(text)) {
    return undefined;
  }
  text = text.trimEnd();
  const startCharacter = position.character - text.length;
  if (startCharacter < 0) {
    return undefined;
  }
  void leadingTrimmed;
  return {
    text,
    start: new vscode.Position(position.line, startCharacter)
  };
}

function readProjectIgnoreList(): Set<string> {
  const config = vscode.workspace.getConfiguration("flarePreview");
  const list = config.get<string[]>("suggestionIgnoreVariables", []) ?? [];
  return new Set(list.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
