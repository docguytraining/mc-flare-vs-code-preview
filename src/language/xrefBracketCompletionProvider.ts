import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { TopicIndex } from "../flare/topicIndex";

const TRIGGER = "[[";

/**
 * Trigger-character completion for cross-reference scaffolding. Anywhere in
 * topic prose, typing `[[` opens a project-wide topic picker. On accept, the
 * `[[` characters are erased and replaced with a complete `<MadCap:xref>` tag
 * pointing at the chosen topic, with the heading prefilled as link text and
 * the cursor positioned to edit it.
 *
 * The companion `xrefCompletionProvider` still handles the case where the
 * author already wrote `<MadCap:xref href="`. This provider is for the
 * "I haven't typed any tag scaffolding yet" entry point.
 */
export class XrefBracketCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly topicIndex: TopicIndex
  ) {}

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    // Only fire when the two characters immediately before the cursor are `[[`.
    if (position.character < 2) {
      return undefined;
    }
    const prefixRange = new vscode.Range(
      new vscode.Position(position.line, position.character - 2),
      position
    );
    if (document.getText(prefixRange) !== TRIGGER) {
      return undefined;
    }
    // Don't trigger inside an existing tag — let the regular xref provider
    // handle attribute-value completion.
    if (cursorIsInsideTag(document, position)) {
      return undefined;
    }

    const projectContext = await this.projectResolver
      .resolveForFile(document.uri)
      .catch(() => undefined);
    if (!projectContext) {
      return undefined;
    }

    const entries = await this.topicIndex.getEntries(projectContext);
    if (entries.length === 0) {
      return undefined;
    }

    const documentDir = path.dirname(document.uri.fsPath);
    // Erase the `[[` AND any auto-inserted `]]` (or partial `]`) that VS
    // Code's bracket auto-close left immediately after the cursor. Without
    // this the inserted xref tag is followed by stray `]]` characters in
    // the topic.
    const replaceRange = expandRangeOverTrailingCloseBrackets(document, position, prefixRange);

    return entries.map((entry) => {
      const relativeFromDocument = path
        .relative(documentDir, entry.absPath)
        .replace(/\\/g, "/");
      const linkText = entry.h1 ?? path.basename(entry.relPath);
      const safeHref = escapeAttribute(relativeFromDocument);
      const safeLink = escapeSnippet(linkText);
      const item = new vscode.CompletionItem(
        { label: linkText, description: entry.relPath },
        vscode.CompletionItemKind.File
      );
      item.detail = `Insert <MadCap:xref href="${relativeFromDocument}">…</MadCap:xref>`;
      item.filterText = `[[${linkText} ${entry.relPath}`;
      item.sortText = entry.relPath;
      item.insertText = new vscode.SnippetString(
        `<MadCap:xref href="${safeHref}">\${1:${safeLink}}</MadCap:xref>$0`
      );
      item.range = replaceRange;
      return item;
    });
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function escapeSnippet(value: string): string {
  // VS Code SnippetString escapes `$`, `}`, and `\` — escape only what would
  // confuse the snippet parser, leave the rest of the heading text intact.
  return value.replace(/[\\$}]/g, (ch) => `\\${ch}`);
}

function cursorIsInsideTag(document: vscode.TextDocument, position: vscode.Position): boolean {
  const lineText = document.lineAt(position.line).text.slice(0, position.character);
  const lastOpen = lineText.lastIndexOf("<");
  const lastClose = lineText.lastIndexOf(">");
  return lastOpen > lastClose;
}

/**
 * VS Code auto-closes `[`/`{` for HTML, so by the time the second `[` (or
 * `{`) lands the document looks like `[[]]` (or `{{}}`) with the cursor
 * sitting between the two halves. The completion item replaces the opening
 * pair with the inserted tag — but unless we widen the replacement range to
 * also cover the trailing closers, the user is left with stray `]]`/`}}`
 * characters after the new tag. Walks at most two characters past the
 * cursor and includes any matching closer it finds.
 */
export function expandRangeOverTrailingCloseBrackets(
  document: vscode.TextDocument,
  position: vscode.Position,
  baseRange: vscode.Range
): vscode.Range {
  const line = document.lineAt(position.line).text;
  let extra = 0;
  while (extra < 2) {
    const ch = line.charAt(position.character + extra);
    if (ch === "]" || ch === "}") {
      extra += 1;
      continue;
    }
    break;
  }
  if (extra === 0) {
    return baseRange;
  }
  return new vscode.Range(
    baseRange.start,
    new vscode.Position(position.line, position.character + extra)
  );
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
