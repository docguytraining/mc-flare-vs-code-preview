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
 * Finds the opening tag of the element that encloses the given position and
 * returns its full range plus the value of any existing `MadCap:conditions=`
 * attribute.
 *
 * Two cases are handled:
 *
 *  1. The cursor sits literally inside an opening tag (between its `<` and
 *     `>`). That tag is returned directly.
 *  2. The cursor sits in text content (the common case). A linear scan
 *     maintains an element stack and returns the deepest open element at the
 *     cursor position.
 *
 * Returns `undefined` for cursors inside closing tags, comments, processing
 * instructions, CDATA, or text content with no enclosing element.
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

  // Tokenize HTML into tags. The order of alternatives matters: comment /
  // CDATA / PI must come before the generic open / close tag patterns so we
  // never misread `<!-- ... -->` as an element.
  const tokenRegex =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)\b[^>]*?(\/?)>/g;

  const stack: { name: string; start: number; end: number; text: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(text)) !== null) {
    const tagStart = match.index;
    const tagEnd = tagStart + match[0].length;

    // Cursor sits strictly inside this token (between `<` and `>`).
    if (offset > tagStart && offset < tagEnd) {
      if (
        match[0].startsWith("<!--") ||
        match[0].startsWith("<![") ||
        match[0].startsWith("<?")
      ) {
        return undefined;
      }
      if (match[1]) {
        // Closing tag — `</p>` is not an element we can attach a condition to.
        return undefined;
      }
      if (match[2]) {
        return buildResult(document, tagStart, tagEnd, match[0]);
      }
      return undefined;
    }

    // Update the element stack only for tokens that end at or before the
    // cursor — anything past it is irrelevant.
    if (tagEnd <= offset) {
      if (
        !match[0].startsWith("<!--") &&
        !match[0].startsWith("<![") &&
        !match[0].startsWith("<?")
      ) {
        if (match[1]) {
          const name = match[1].toLowerCase();
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            if (stack[i].name === name) {
              stack.splice(i);
              break;
            }
          }
        } else if (match[2]) {
          const name = match[2].toLowerCase();
          const isSelfClosing = match[3] === "/" || isVoidElement(name);
          if (!isSelfClosing) {
            stack.push({ name, start: tagStart, end: tagEnd, text: match[0] });
          }
        }
      }
    }

    if (tagStart >= offset) {
      break;
    }
  }

  // Cursor is in text content. The deepest unclosed element wins.
  if (stack.length === 0) {
    return undefined;
  }
  const top = stack[stack.length - 1];
  return buildResult(document, top.start, top.end, top.text);
}

function buildResult(
  document: vscode.TextDocument,
  start: number,
  end: number,
  tagText: string
): { tagRange: vscode.Range; existingConditions: string | undefined } {
  const conditionsMatch = tagText.match(
    /\bMadCap:conditions\s*=\s*(["'])([^"']*)\1/i
  );
  return {
    tagRange: new vscode.Range(
      document.positionAt(start),
      document.positionAt(end)
    ),
    existingConditions: conditionsMatch ? conditionsMatch[2] : undefined
  };
}

function isVoidElement(name: string): boolean {
  return new Set([
    "br",
    "hr",
    "img",
    "input",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "source",
    "track",
    "wbr"
  ]).has(name);
}
