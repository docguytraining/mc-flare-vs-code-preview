import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { Bookmark, TopicIndex, TopicIndexEntry } from "../flare/topicIndex";

interface TopicQuickPickItem extends vscode.QuickPickItem {
  entry: TopicIndexEntry;
}

interface BookmarkQuickPickItem extends vscode.QuickPickItem {
  bookmark?: Bookmark;
}

export function registerInsertXrefCommand(
  projectResolver: FlareProjectResolver,
  topicIndex: TopicIndex
): vscode.Disposable {
  return vscode.commands.registerCommand("flare.insertXref", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a Flare topic before inserting a cross-reference.");
      return;
    }

    await runXrefPicker(editor, editor.document, editor.selection, projectResolver, topicIndex);
  });
}

/**
 * Companion command to {@link registerInsertXrefCommand}: takes an explicit
 * document URI and range (rather than reading from the active editor) and
 * replaces that range with a cross-reference. The link text defaults to the
 * range's existing text. This backs the "Convert to cross-reference…" code
 * action surfaced by {@link WrapSelectionAsXrefProvider}.
 */
export function registerWrapSelectionAsXrefCommand(
  projectResolver: FlareProjectResolver,
  topicIndex: TopicIndex
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "flare.wrapSelectionAsXref",
    async (uri?: vscode.Uri, range?: vscode.Range) => {
      if (!uri || !range) {
        return;
      }
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        return;
      }
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const selection = new vscode.Selection(range.start, range.end);
      editor.selection = selection;
      await runXrefPicker(editor, document, selection, projectResolver, topicIndex);
    }
  );
}

async function runXrefPicker(
  editor: vscode.TextEditor,
  document: vscode.TextDocument,
  selection: vscode.Selection,
  projectResolver: FlareProjectResolver,
  topicIndex: TopicIndex
): Promise<void> {
    const projectContext = await projectResolver.resolveForFile(document.uri);
    if (!projectContext) {
      vscode.window.showWarningMessage(
        "Flare: no .flprj project was found above this topic. Cross-reference insertion requires a project."
      );
      return;
    }

    const entries = await topicIndex.getEntries(projectContext);
    if (entries.length === 0) {
      vscode.window.showInformationMessage("No topics were found in the current Flare project.");
      return;
    }

    const topicItems: TopicQuickPickItem[] = entries.map((entry) => ({
      entry,
      label: entry.h1 ?? path.basename(entry.relPath),
      description: entry.relPath,
      detail: entry.h1 ? undefined : "(no <h1> — showing file name)"
    }));

    const topicPick = await vscode.window.showQuickPick(topicItems, {
      title: "Flare: Insert Cross-Reference",
      placeHolder: "Search topics by heading or path…",
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!topicPick) {
      return;
    }

    const bookmarks = await topicIndex.getBookmarks(topicPick.entry.uri);
    let chosenBookmark: Bookmark | undefined;
    if (bookmarks.length > 0) {
      const bookmarkItems: BookmarkQuickPickItem[] = [
        { label: "(none — link to the top of the topic)" },
        ...bookmarks.map<BookmarkQuickPickItem>((bookmark) => ({
          label: `#${bookmark.id}`,
          description: bookmark.element,
          bookmark
        }))
      ];
      const bookmarkPick = await vscode.window.showQuickPick(bookmarkItems, {
        title: `Flare: Bookmark inside ${topicPick.entry.relPath}`,
        placeHolder: "Pick a bookmark or leave unset"
      });
      if (!bookmarkPick) {
        return;
      }
      chosenBookmark = bookmarkPick.bookmark;
    }

    const relativeHref = buildRelativeHref(document.uri.fsPath, topicPick.entry.absPath, chosenBookmark);
    const selectedText = document.getText(selection);
    const linkText = selectedText.trim().length > 0
      ? selectedText
      : topicPick.entry.h1 ?? path.basename(topicPick.entry.relPath);

    const snippet = new vscode.SnippetString();
    snippet.appendText(`<MadCap:xref href="${relativeHref}">`);
    snippet.appendPlaceholder(linkText);
    snippet.appendText("</MadCap:xref>");

    await editor.insertSnippet(snippet, selection);
}

function buildRelativeHref(
  fromTopicPath: string,
  toTopicPath: string,
  bookmark: Bookmark | undefined
): string {
  const relative = path.relative(path.dirname(fromTopicPath), toTopicPath).replace(/\\/g, "/");
  const normalized = relative.length === 0 ? path.basename(toTopicPath) : relative;
  return bookmark ? `${normalized}#${bookmark.id}` : normalized;
}
