import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";
import { DismissalStore } from "../diagnostics/dismissalStore";
import { resolveIgnoredValues } from "./variableSuggestionEngine";

const MAX_PREFIX_SCAN = 120;
const MIN_PREFIX_LENGTH_FOR_VALUE_COMPLETION = 3;
const MAX_PREFIX_WORDS = 8;

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
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly dismissalStore: DismissalStore
  ) {}

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

    const sidecarDismissals = await this.dismissalStore
      .getDismissedVariables(projectContext, document.uri)
      .catch(() => [] as string[]);
    return this.buildValuePrefixCompletions(
      document,
      position,
      linePrefix,
      variableResult.variables,
      sidecarDismissals
    );
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
    _document: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string,
    variables: Map<string, string>,
    sidecarDismissals: string[]
  ): vscode.CompletionItem[] | undefined {
    // We only want to fire in flowing prose, not inside or right next to an
    // HTML tag. Walk backward from the cursor and bail if the most recent
    // angle bracket we see is an opening `<`.
    if (isInsideTag(linePrefix)) {
      return undefined;
    }

    const candidates = extractPrefixCandidates(linePrefix, position);
    if (candidates.length === 0) {
      return undefined;
    }

    const projectIgnore = readProjectIgnoreList();
    const ignoreList = new Set([...projectIgnore, ...sidecarDismissals]);
    // Resolve the ignore list to the underlying variable *values* so that
    // both the qualified and bare map entries for a dismissed variable are
    // suppressed in one go. Without this, dismissing `Set.Name` would still
    // leak the bare `Name` entry into the completion list.
    const ignoredValues = resolveIgnoredValues(variables, ignoreList);

    // For each variable, find the longest candidate prefix (candidates are
    // pre-sorted longest first) that matches the start of its value. This
    // means typing "Trust Pro" in "…love Trust Pro|" still matches the full
    // "Trust Protection Foundation" even though the bare last word "Pro"
    // would also be a candidate.
    //
    // Only use qualified variable names (Set.Name) in value-prefix completions.
    // Bare names are ambiguous when multiple variable sets define the same
    // variable name, and using them can result in broken references that don't
    // resolve correctly in the preview or in Flare.
    const items: vscode.CompletionItem[] = [];
    const seenValues = new Map<string, string>(); // value -> qualified name
    for (const [name, value] of variables.entries()) {
      // Skip bare names — only use qualified names (containing a dot)
      if (!name.includes(".")) {
        continue;
      }

      const trimmedValue = value.trim();
      if (ignoredValues.has(trimmedValue)) {
        continue;
      }

      let matchedCandidate: PrefixCandidate | undefined;
      for (const candidate of candidates) {
        if (trimmedValue.length < candidate.text.length) {
          continue;
        }
        if (trimmedValue.startsWith(candidate.text)) {
          matchedCandidate = candidate;
          break;
        }
      }
      if (!matchedCandidate) {
        continue;
      }

      // If multiple qualified names have the same value (e.g., two different
      // sets both define a variable with the same resolved value), use the
      // first one encountered. The variables map iterates in insertion order,
      // and qualified names are inserted before their bare fallbacks.
      if (seenValues.has(trimmedValue)) {
        continue;
      }

      seenValues.set(trimmedValue, name);
    }

    // Build completion items from the deduplicated value map
    for (const [trimmedValue, name] of seenValues.entries()) {
      const matchedCandidate = candidates.find((c) => trimmedValue.startsWith(c.text));
      if (!matchedCandidate) {
        continue; // Should not happen, but guard anyway
      }

      const replaceRange = new vscode.Range(matchedCandidate.start, position);
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

interface PrefixCandidate {
  text: string;
  start: vscode.Position;
}

/**
 * Walks backward from the cursor to collect prose being typed, then returns
 * a set of candidate prefixes of increasing length:
 *
 *   "…and our product is CyberArk promises you will love Cyber|"
 *     → ["Cyber", "love Cyber", "will love Cyber", "you will love Cyber", …]
 *
 *   "<p>Trust Pro|"
 *     → ["Pro", "Trust Pro"]
 *
 * Candidates are returned **longest first** so callers can prefer longer
 * matches over shorter ones (so typing "Trust Pro" lands on "Trust
 * Protection Foundation" instead of a shorter "Pro…" variable).
 *
 * Stops collecting at the last HTML bracket, quote, or newline — those are
 * boundaries that can't be part of flowing prose. Excludes candidates that
 * are shorter than `MIN_PREFIX_LENGTH_FOR_VALUE_COMPLETION`, end in
 * whitespace, or contain no letters.
 */
function extractPrefixCandidates(
  linePrefix: string,
  position: vscode.Position
): PrefixCandidate[] {
  const scanStart = Math.max(0, linePrefix.length - MAX_PREFIX_SCAN);
  let cut = linePrefix.length;
  for (let i = linePrefix.length - 1; i >= scanStart; i -= 1) {
    const ch = linePrefix.charAt(i);
    if (ch === "<" || ch === ">" || ch === '"' || ch === "'") {
      cut = i + 1;
      break;
    }
    cut = i;
  }

  const rawSegment = linePrefix.slice(cut);
  // Don't trigger if the user just finished a word (trailing whitespace).
  if (/\s$/.test(rawSegment) || rawSegment.length === 0) {
    return [];
  }

  // Split on ASCII whitespace while remembering each word's start offset
  // relative to the full line, so we can reconstruct the replace range.
  interface Word {
    text: string;
    startOffset: number;
  }
  const words: Word[] = [];
  const wordRegex = /\S+/g;
  let match = wordRegex.exec(rawSegment);
  while (match) {
    words.push({ text: match[0], startOffset: cut + match.index });
    match = wordRegex.exec(rawSegment);
  }
  if (words.length === 0) {
    return [];
  }

  const candidates: PrefixCandidate[] = [];
  const maxCandidates = Math.min(words.length, MAX_PREFIX_WORDS);
  // Build progressively longer candidates: last word, last two, last three…
  for (let take = 1; take <= maxCandidates; take += 1) {
    const firstIndex = words.length - take;
    const first = words[firstIndex];
    const text = linePrefix.slice(first.startOffset);
    if (text.length < MIN_PREFIX_LENGTH_FOR_VALUE_COMPLETION) {
      continue;
    }
    if (!/[A-Za-z]/.test(text)) {
      continue;
    }
    const startCharacter = position.character - text.length;
    if (startCharacter < 0) {
      continue;
    }
    candidates.push({
      text,
      start: new vscode.Position(position.line, startCharacter)
    });
  }

  // Return longest-first so callers that want to prefer longer matches can
  // iterate in order and break on the first hit.
  return candidates.reverse();
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
