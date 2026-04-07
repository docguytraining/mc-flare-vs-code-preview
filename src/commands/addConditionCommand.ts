import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { ConditionTagIndex } from "../flare/conditionTagIndex";

/**
 * Registers `flare.addConditionToElement`. Pops a multi-select quick pick of
 * every `<set>.<tag>` known to the project and rewrites the supplied tag
 * range to include a `MadCap:conditions="…"` attribute (or extends the
 * existing one with the new selections, deduplicated). Backs the
 * `AddConditionCodeActionProvider` refactor action.
 */
export function registerAddConditionCommand(
  projectResolver: FlareProjectResolver,
  conditionTagIndex: ConditionTagIndex
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "flare.addConditionToElement",
    async (
      uri?: vscode.Uri,
      tagRange?: vscode.Range,
      existingConditions?: string
    ) => {
      if (!uri || !tagRange) {
        return;
      }
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        return;
      }
      const projectContext = await projectResolver
        .resolveForFile(document.uri)
        .catch(() => undefined);
      if (!projectContext) {
        vscode.window.showWarningMessage(
          "Flare: cannot add a condition because no .flprj project was found above this topic."
        );
        return;
      }
      const tags = await conditionTagIndex.getEntries(projectContext);
      if (tags.length === 0) {
        vscode.window.showInformationMessage(
          "Flare: no condition tags are defined in this project."
        );
        return;
      }

      const existingTokens = parseConditionList(existingConditions ?? "");
      const items = tags.map((tag) => ({
        label: tag.qualifiedName,
        description: tag.description ?? `Defined in ${tag.setName}.flcts`,
        picked: existingTokens.includes(tag.qualifiedName)
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "Add MadCap:conditions",
        placeHolder: "Pick the tag(s) that should gate this element",
        canPickMany: true
      });
      if (!picked || picked.length === 0) {
        return;
      }

      // Merge any pre-checked tokens that the user left checked with their
      // new picks, then dedupe while preserving order.
      const merged: string[] = [];
      for (const entry of [...existingTokens, ...picked.map((p) => p.label)]) {
        if (!merged.includes(entry)) {
          merged.push(entry);
        }
      }
      const newAttributeValue = merged.join(",");

      const tagText = document.getText(tagRange);
      const rewritten = rewriteTagWithConditions(tagText, newAttributeValue);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, tagRange, rewritten);
      await vscode.workspace.applyEdit(edit);
    }
  );
}

/**
 * Splits a `MadCap:conditions=` value into individual tokens. Flare accepts
 * both comma- and semicolon-delimited lists; we mirror that here.
 */
export function parseConditionList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Rewrites an opening tag's text to set its `MadCap:conditions` attribute to
 * `newValue`. If the attribute exists, replaces its value in place; otherwise
 * inserts the attribute immediately after the tag name.
 */
export function rewriteTagWithConditions(tagText: string, newValue: string): string {
  const existing = /\bMadCap:conditions\s*=\s*(["'])([^"']*)\1/i;
  if (existing.test(tagText)) {
    return tagText.replace(existing, `MadCap:conditions="${newValue}"`);
  }
  // Insert after `<tagName` (and any namespace prefix).
  const tagNameMatch = tagText.match(/^<([A-Za-z][\w:.-]*)/);
  if (!tagNameMatch) {
    return tagText;
  }
  const insertAt = 1 + tagNameMatch[1].length;
  return (
    tagText.slice(0, insertAt) +
    ` MadCap:conditions="${newValue}"` +
    tagText.slice(insertAt)
  );
}
