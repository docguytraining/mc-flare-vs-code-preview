import * as vscode from "vscode";

/**
 * Applies a `WorkspaceEdit` that touches many files and tidies up after
 * itself so the user doesn't end up with dozens of dirty unsaved tabs they
 * have to manually save and close.
 *
 * VS Code's default behavior when `applyEdit` modifies a file that wasn't
 * already open in an editor is to open it as a *dirty unsaved tab* so the
 * author can spot-check the change before committing it. That's the right
 * UX for Search & Replace ("preview the diff and decide what to keep") but
 * the wrong UX for a Rename refactor across hundreds of files — the author
 * already reviewed and confirmed the changes in the multi-select picker
 * upstream, so we want the edit applied and the files saved and closed
 * automatically.
 *
 * Behavior:
 *
 *   1. Snapshot every editor URI that's open *before* the edit so we can
 *      tell which tabs the user already had vs. which ones VS Code opened
 *      in response to our edit.
 *   2. Apply the edit inside a progress notification so a long save phase
 *      doesn't make the dev host appear frozen.
 *   3. Save every dirty document VS Code dirtied as a result of the edit.
 *   4. Close any tabs that weren't already open before the rename. Tabs
 *      the user had open at the start (including the file they invoked
 *      the rename from) stay open and refresh in place.
 *
 * Returns the number of files actually modified plus a boolean indicating
 * whether the edit applied successfully.
 */
export interface ApplyAndCloseResult {
  applied: boolean;
  modifiedFileCount: number;
}

export async function applyEditAndCleanUpTabs(
  edit: vscode.WorkspaceEdit,
  options: { progressTitle: string }
): Promise<ApplyAndCloseResult> {
  // Snapshot the URIs of every tab that's currently open. We use the
  // tab API rather than `visibleTextEditors` because the latter only
  // covers editors that are visually rendered right now — a background
  // tab in another column is still "open" from the user's perspective
  // and shouldn't be closed by us.
  const previouslyOpenUris = new Set<string>();
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        previouslyOpenUris.add(input.uri.toString());
      }
    }
  }

  // Collect the URIs the edit is going to touch *before* we apply it, so
  // we know which files to save and which tabs to close even if applyEdit
  // ends up dirtying tabs we didn't list explicitly (it shouldn't, but
  // belt-and-suspenders).
  const editedUris = new Set<string>();
  for (const [uri] of edit.entries()) {
    editedUris.add(uri.toString());
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.progressTitle,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: `Applying edits to ${editedUris.size} file(s)…` });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { applied: false, modifiedFileCount: 0 };
      }

      // Save every document the edit touched. We iterate the explicit list
      // rather than relying on `workspace.saveAll` because saveAll is a
      // sledgehammer — it saves *every* dirty document in the workspace,
      // including ones the user was editing themselves and not done with.
      progress.report({ message: `Saving ${editedUris.size} file(s)…` });
      let savedCount = 0;
      for (const uriString of editedUris) {
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.toString() === uriString
        );
        if (document && document.isDirty) {
          try {
            const ok = await document.save();
            if (ok) {
              savedCount += 1;
            }
          } catch {
            // Ignore individual save failures — we'll report the aggregate
            // count and let the user investigate via the editor.
          }
        } else if (document) {
          // Document is loaded but not dirty — applyEdit may have written
          // through directly. Count it as saved for the result tally.
          savedCount += 1;
        }
      }

      // Close any tabs that weren't open before but are now (i.e. tabs VS
      // Code opened in response to our edit). Tabs the user already had
      // open stay open so they can see the in-place refresh.
      progress.report({ message: "Closing temporary tabs…" });
      const tabsToClose: vscode.Tab[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input;
          if (
            (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) &&
            editedUris.has(input.uri.toString()) &&
            !previouslyOpenUris.has(input.uri.toString())
          ) {
            tabsToClose.push(tab);
          }
        }
      }
      if (tabsToClose.length > 0) {
        try {
          await vscode.window.tabGroups.close(tabsToClose);
        } catch {
          // Closing tabs is best-effort; ignore failures so the rename
          // result is still reported.
        }
      }

      return { applied: true, modifiedFileCount: savedCount };
    }
  );
}
