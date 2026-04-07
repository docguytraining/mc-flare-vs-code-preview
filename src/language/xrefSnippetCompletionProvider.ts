import * as vscode from "vscode";

const KEYWORDS = ["xref", "cond", "cblock", "snip", "snipblock", "var"] as const;

/**
 * Static snippet completions surfaced by normal IntelliSense — `xref`, `cond`,
 * and `cblock` expand to fully-formed MadCap tags with tab stops, so authors
 * who already know what they want can scaffold without typing the brackets.
 *
 * These don't need any project context (and intentionally don't ask for one)
 * so they're available as soon as the editor opens.
 */
export class XrefSnippetCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(
    document: vscode.TextDocument
  ): vscode.CompletionItem[] | undefined {
    if (!isFlareTopic(document)) {
      return undefined;
    }
    const items: vscode.CompletionItem[] = [];

    for (const keyword of KEYWORDS) {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Snippet);
      item.detail = describe(keyword);
      item.insertText = snippetFor(keyword);
      item.sortText = `0_${keyword}`;
      // Every keyword expansion parks the cursor inside an empty attribute
      // (`href=""`, `conditions=""`, `src=""`). VS Code does NOT auto-fire
      // IntelliSense in that position, so the author would have to press
      // Ctrl+Space manually. Re-trigger Suggest after acceptance so the
      // matching attribute-value provider (xref / condition / snippet src)
      // takes over without an extra keystroke.
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Re-trigger suggest"
      };
      items.push(item);
    }

    return items;
  }
}

function describe(keyword: typeof KEYWORDS[number]): string {
  switch (keyword) {
    case "xref":
      return "Insert <MadCap:xref href=\"…\">link text</MadCap:xref>";
    case "cond":
      return "Insert MadCap:conditions=\"…\" attribute";
    case "cblock":
      return "Wrap content in <MadCap:conditionalBlock>";
    case "snip":
      return "Insert inline <MadCap:snippet src=\"…\" />";
    case "snipblock":
      return "Insert block <MadCap:snippetBlock src=\"…\" />";
    case "var":
      return "Insert <MadCap:variable name=\"…\" />";
  }
}

function snippetFor(keyword: typeof KEYWORDS[number]): vscode.SnippetString {
  switch (keyword) {
    case "xref":
      return new vscode.SnippetString('<MadCap:xref href="$1">${2:link text}</MadCap:xref>$0');
    case "cond":
      return new vscode.SnippetString('MadCap:conditions="$1"$0');
    case "cblock":
      return new vscode.SnippetString(
        '<MadCap:conditionalBlock MadCap:conditions="$1">\n  $0\n</MadCap:conditionalBlock>'
      );
    case "snip":
      return new vscode.SnippetString('<MadCap:snippet src="$1" />$0');
    case "snipblock":
      return new vscode.SnippetString('<MadCap:snippetBlock src="$1" />$0');
    case "var":
      return new vscode.SnippetString('<MadCap:variable name="$1" />$0');
  }
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
