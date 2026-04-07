import * as vscode from "vscode";
import { isFlareDocument } from "../core/fileTypeHelpers";

const COMMAND = "flare.addConditionToElement";

/**
 * Code action that surfaces an "Add condition…" refactor on any opening tag in
 * a Flare topic. Choosing the action runs `flare.addConditionToElement`, which
 * opens a multi-select quick pick of every condition tag known to the project
 * and inserts a `MadCap:conditions="…"` attribute (or appends to an existing
 * one) on the chosen element.
 *
 * The companion command is registered in `extension.ts` so it can reach the
 * project resolver and the condition tag index.
 */
export class AddConditionCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]
  };

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] | undefined {
    if (!isFlareDocument(document)) {
      return undefined;
    }
    const tagInfo = findEnclosingOpeningTag(document, range.start);
    if (!tagInfo) {
      return undefined;
    }
    const action = new vscode.CodeAction(
      "Add Condition to Element…",
      vscode.CodeActionKind.RefactorRewrite
    );
    action.command = {
      command: COMMAND,
      title: "Add Condition to Element…",
      arguments: [document.uri, tagInfo.tagRange, tagInfo.existingConditions]
    };
    return [action];
  }
}

/**
 * Finds the opening tag (`<tagName ...>`) that contains the given position
 * and returns its full range plus the value of any existing
 * `MadCap:conditions=` attribute. Returns `undefined` when the cursor is not
 * inside an opening tag — most notably when sitting in text content or
 * inside a closing tag.
 */
export function findEnclosingOpeningTag(
  document: vscode.TextDocument,
  position: vscode.Position
):
  | {
      tagRange: vscode.Range;
      existingConditions: string | undefined;
    }
  | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  // Walk backwards from `offset` looking for an unmatched `<`.
  let i = offset;
  while (i > 0) {
    const ch = text.charAt(i - 1);
    if (ch === ">") {
      return undefined;
    }
    if (ch === "<") {
      break;
    }
    i -= 1;
  }
  if (i === 0 && text.charAt(0) !== "<") {
    return undefined;
  }
  const start = i - 1;
  // Walk forwards from `offset` looking for the next `>`.
  let j = offset;
  while (j < text.length && text.charAt(j) !== ">") {
    j += 1;
  }
  if (j >= text.length) {
    return undefined;
  }
  const tagText = text.slice(start, j + 1);
  // Reject closing tags (`</…>`) and comments (`<!--`).
  if (tagText.startsWith("</") || tagText.startsWith("<!")) {
    return undefined;
  }
  // Reject XML processing instructions and CDATA.
  if (tagText.startsWith("<?") || tagText.startsWith("<![")) {
    return undefined;
  }
  // Must look like a real tag (`<` followed by an identifier character).
  if (!/^<[A-Za-z]/.test(tagText)) {
    return undefined;
  }
  const conditionsMatch = tagText.match(
    /\bMadCap:conditions\s*=\s*(["'])([^"']*)\1/i
  );
  return {
    tagRange: new vscode.Range(
      document.positionAt(start),
      document.positionAt(j + 1)
    ),
    existingConditions: conditionsMatch ? conditionsMatch[2] : undefined
  };
}

