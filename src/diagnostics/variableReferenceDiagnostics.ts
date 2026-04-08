import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { resolveVariables } from "../flare/variableResolver";

const DIAGNOSTIC_SOURCE = "flare";
export const VARIABLE_UNRESOLVED_CODE = "flare.variable-unresolved";

const VARIABLE_REFERENCE_REGEX =
  /<MadCap:variable\b[^>]*\bname\s*=\s*(["'])([^"']*)\1/gi;

interface VariableReference {
  name: string;
  /** Offset of the first character of the attribute value (after the quote). */
  valueStart: number;
  valueLength: number;
}

/**
 * Walks a Flare topic for `<MadCap:variable name="…">` references and emits
 * Warning diagnostics whenever the named variable cannot be resolved against
 * the project's `.flvar` files. Restores the squiggly underline that authors
 * relied on to spot typo'd or missing variable references in the editor
 * without opening the Live Preview.
 *
 * Kept separate from `VariableSuggestionEngine` (which is about literal-text
 * → variable refactor *suggestions*) so the two diagnostic streams can be
 * styled differently — unresolved references are real errors, suggestions
 * are opportunistic refactors.
 */
export class VariableReferenceDiagnostics {
  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly projectResolver: FlareProjectResolver
  ) {}

  public async refresh(document: vscode.TextDocument): Promise<void> {
    if (!isFlareTopic(document)) {
      return;
    }

    const text = document.getText();
    const references = collectReferences(text);
    if (references.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }

    let projectContext;
    try {
      projectContext = await this.projectResolver.resolveForFile(document.uri);
    } catch {
      this.diagnostics.delete(document.uri);
      return;
    }

    // resolveVariables also walks the document for references and figures
    // out which ones are unresolved, but it returns the unique *names*, not
    // their positions. We need positions to draw squiggles, so do our own
    // pass after resolving the variable map.
    const variableResult = await resolveVariables(text, projectContext);
    const known = variableResult.variables;

    const entries: vscode.Diagnostic[] = [];
    for (const reference of references) {
      const trimmed = reference.name.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (known.has(trimmed)) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(reference.valueStart),
        document.positionAt(reference.valueStart + reference.valueLength)
      );
      const message = projectContext
        ? `Unresolved Flare variable '${trimmed}'. No matching <Variable Name="${trimmed}"> found in any project .flvar file.`
        : `Cannot resolve Flare variable '${trimmed}' — no .flprj project was found above this topic.`;
      const diagnostic = new vscode.Diagnostic(
        range,
        message,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = VARIABLE_UNRESOLVED_CODE;
      entries.push(diagnostic);
    }

    if (entries.length === 0) {
      this.diagnostics.delete(document.uri);
    } else {
      this.diagnostics.set(document.uri, entries);
    }
  }

  public clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
  }
}

/**
 * Pure helper exposed for unit tests. Returns every `<MadCap:variable
 * name="…">` reference in the text, with the precise offset of the
 * attribute value so the caller can build a `vscode.Range`.
 */
export function collectReferences(text: string): VariableReference[] {
  const references: VariableReference[] = [];
  VARIABLE_REFERENCE_REGEX.lastIndex = 0;
  let match = VARIABLE_REFERENCE_REGEX.exec(text);
  while (match) {
    const value = match[2] ?? "";
    const fullEnd = match.index + match[0].length;
    // Match ends with the closing quote; the captured value occupies the
    // bytes immediately preceding that quote.
    const valueStart = fullEnd - 1 - value.length;
    references.push({
      name: value,
      valueStart,
      valueLength: value.length
    });
    match = VARIABLE_REFERENCE_REGEX.exec(text);
  }
  return references;
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
