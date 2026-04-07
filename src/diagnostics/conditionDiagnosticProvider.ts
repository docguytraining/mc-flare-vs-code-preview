import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { ConditionTagIndex } from "../flare/conditionTagIndex";
import { parseConditionsAttribute } from "../flare/conditionExpression";
import { isFlareDocument } from "../core/fileTypeHelpers";

const DIAGNOSTIC_SOURCE = "flare";
const DIAGNOSTIC_CODE = "flare.condition-unresolved";

const CONDITIONS_ATTR_REGEX =
  /\bMadCap:conditions\s*=\s*(["'])([^"']*)\1/gi;
const CONDITION_EXPRESSION_ATTR_REGEX =
  /\bMadCap:conditionTagExpression\s*=\s*(["'])([^"']*)\1/gi;

/**
 * Adds Problems-panel diagnostics for any `MadCap:conditions=` or
 * `MadCap:conditionTagExpression=` reference whose `<set>.<tag>` token does
 * not resolve to a known entry in the project's condition tag index. The
 * diagnostic range covers the offending token specifically (not the whole
 * attribute) so authors can jump straight to the typo.
 */
export class ConditionDiagnosticProvider {
  public constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly projectResolver: FlareProjectResolver,
    private readonly conditionTagIndex: ConditionTagIndex
  ) {}

  public async validate(document: vscode.TextDocument): Promise<void> {
    if (!isFlareDocument(document)) {
      return;
    }
    const projectContext = await this.projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      this.diagnostics.delete(document.uri);
      return;
    }

    const knownTags = await this.conditionTagIndex.getEntries(projectContext);
    const known = new Set(knownTags.map((tag) => tag.qualifiedName));

    const text = document.getText();
    const entries: vscode.Diagnostic[] = [];

    const collect = (regex: RegExp): void => {
      regex.lastIndex = 0;
      let match = regex.exec(text);
      while (match) {
        const valueStart = match.index + match[0].length - 1 - match[2].length;
        const tags = parseConditionsAttribute(match[2]);
        // For tag-list shorthand we can validate each individually. For full
        // expressions (`include[…]` etc.) parseConditionsAttribute returns a
        // single entry that may contain operators; the validator only fires
        // when the entry looks like a bare qualified name to avoid false
        // positives on richer expressions.
        for (const tag of tags) {
          if (!looksLikeBareTag(tag)) {
            continue;
          }
          if (known.has(tag)) {
            continue;
          }
          const offsetInValue = match[2].indexOf(tag);
          if (offsetInValue < 0) {
            continue;
          }
          const tokenStart = valueStart + offsetInValue;
          const range = new vscode.Range(
            document.positionAt(tokenStart),
            document.positionAt(tokenStart + tag.length)
          );
          const diagnostic = new vscode.Diagnostic(
            range,
            `Unknown Flare condition tag '${tag}'. No matching entry was found in any .flcts file under Project/ConditionTagSets.`,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = DIAGNOSTIC_SOURCE;
          diagnostic.code = DIAGNOSTIC_CODE;
          entries.push(diagnostic);
        }
        match = regex.exec(text);
      }
    };

    collect(CONDITIONS_ATTR_REGEX);
    collect(CONDITION_EXPRESSION_ATTR_REGEX);

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

function looksLikeBareTag(value: string): boolean {
  return /^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/.test(value);
}
