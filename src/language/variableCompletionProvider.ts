import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";

/**
 * Completion provider for Flare variables:
 *  - Triggered after `$`: completes `${VariableName}` shorthand.
 *  - Triggered inside `<MadCap:variable name="…">`: completes the name attribute.
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
    const mode = detectCompletionMode(linePrefix);
    if (!mode) {
      return undefined;
    }

    const items: vscode.CompletionItem[] = [];
    for (const [name, value] of variableResult.variables.entries()) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
      item.detail = truncate(value, 80);
      item.documentation = new vscode.MarkdownString(
        `**${name}**\n\n${escapeMarkdown(value)}`
      );
      item.sortText = name;

      if (mode.kind === "dollar") {
        // Replace the already-typed `$` (and any partial `${…`) with a complete `${Name}`.
        item.insertText = `{${name}}`;
        item.filterText = `$${name}`;
      } else {
        item.insertText = name;
        item.filterText = name;
      }

      items.push(item);
    }

    return items;
  }
}

type CompletionMode = { kind: "dollar" } | { kind: "name-attribute" };

function detectCompletionMode(linePrefix: string): CompletionMode | undefined {
  // Inside `<MadCap:variable name="…` (capture possibly-empty partial name).
  if (/<MadCap:variable\b[^>]*\bname\s*=\s*["'][^"']*$/i.test(linePrefix)) {
    return { kind: "name-attribute" };
  }

  // After `$` or `${` without a closing `}` yet.
  if (/\$\{?[A-Za-z0-9_.-]*$/.test(linePrefix)) {
    return { kind: "dollar" };
  }

  return undefined;
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
