import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";

const MADCAP_VARIABLE_REGEX = /<MadCap:variable\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>(?:\s*<\/MadCap:variable>)?/gi;

/**
 * Renders the resolved value of a MadCap variable reference as an inline hint
 * next to the reference. Read-only; never mutates the document.
 */
export class VariableInlayHintsProvider implements vscode.InlayHintsProvider {
  public constructor(private readonly projectResolver: FlareProjectResolver) {}

  public async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    if (!isFlareTopic(document)) {
      return [];
    }

    const enabled = vscode.workspace
      .getConfiguration("flarePreview")
      .get<boolean>("inlayHints.variables", true);
    if (!enabled) {
      return [];
    }

    let projectContext;
    try {
      projectContext = await this.projectResolver.resolveForFile(document.uri);
    } catch {
      return [];
    }
    if (!projectContext) {
      return [];
    }

    const variableResult = await resolveVariables(document.getText(), projectContext);
    if (variableResult.variables.size === 0) {
      return [];
    }

    const hints: vscode.InlayHint[] = [];
    const rangeStartOffset = document.offsetAt(range.start);
    const rangeEndOffset = document.offsetAt(range.end);
    const text = document.getText();

    const addHint = (offset: number, name: string) => {
      if (offset < rangeStartOffset || offset > rangeEndOffset) {
        return;
      }
      const value = variableResult.variables.get(name);
      if (value === undefined) {
        return;
      }
      const position = document.positionAt(offset);
      const hint = new vscode.InlayHint(
        position,
        ` ▸ ${truncate(value, 60)}`,
        vscode.InlayHintKind.Type
      );
      hint.tooltip = new vscode.MarkdownString(
        `**${name}**: ${escapeMarkdown(value)}`
      );
      hint.paddingLeft = true;
      hints.push(hint);
    };

    MADCAP_VARIABLE_REGEX.lastIndex = 0;
    let madcapMatch = MADCAP_VARIABLE_REGEX.exec(text);
    while (madcapMatch) {
      const end = madcapMatch.index + madcapMatch[0].length;
      addHint(end, madcapMatch[1]);
      madcapMatch = MADCAP_VARIABLE_REGEX.exec(text);
    }

    return hints;
  }
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
