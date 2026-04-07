import * as vscode from "vscode";
import { logInfo, logWarning } from "../core/logger";

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
 * Comparisons across the tab list, the workspace edit, and the loaded
 * text documents all happen via `Uri.fsPath` rather than `Uri.toString()`
 * because Uri's string form can normalize differently depending on how
 * the Uri was constructed (`Uri.file()` vs `openTextDocument()` vs the
 * tab API), and we need a single canonical key. fsPath is the OS-native
 * filesystem path and is identical across every construction route on
 * a given platform.
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
  // Snapshot the fsPaths of every tab that's currently open. We use the
  // tab API rather than `visibleTextEditors` because the latter only
  // covers editors that are visually rendered right now — a background
  // tab in another column is still "open" from the user's perspective
  // and shouldn't be closed by us.
  const previouslyOpenPaths = collectOpenTabPaths();

  // Collect the fsPaths the edit is going to touch *before* we apply it.
  const editedPaths = new Set<string>();
  for (const [uri] of edit.entries()) {
    editedPaths.add(uri.fsPath);
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.progressTitle,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: `Applying edits to ${editedPaths.size} file(s)…` });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { applied: false, modifiedFileCount: 0 };
      }

      // Save every document the edit touched. We iterate the explicit list
      // rather than relying on `workspace.saveAll` because saveAll is a
      // sledgehammer — it saves *every* dirty document in the workspace,
      // including ones the user was editing themselves and not done with.
      progress.report({ message: `Saving ${editedPaths.size} file(s)…` });
      let savedCount = 0;
      for (const fsPath of editedPaths) {
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.fsPath === fsPath
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
      //
      // Yield to the event loop first. VS Code's tab list isn't always
      // updated synchronously after applyEdit + save — when applyEdit
      // surfaces a previously-loaded document as a new dirty tab, that
      // tab can take a microtask or two to register in `tabGroups.all`.
      // Without the yield the close walk runs against a stale tab list
      // and finds nothing to close.
      progress.report({ message: "Closing temporary tabs…" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const tabsToClose: vscode.Tab[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input;
          const tabPath =
            input instanceof vscode.TabInputText ||
            input instanceof vscode.TabInputCustom
              ? input.uri.fsPath
              : undefined;
          if (
            tabPath !== undefined &&
            editedPaths.has(tabPath) &&
            !previouslyOpenPaths.has(tabPath)
          ) {
            tabsToClose.push(tab);
          }
        }
      }

      logInfo(
        `applyEditAndCleanUpTabs: edited=${editedPaths.size}, previouslyOpen=${previouslyOpenPaths.size}, tabsToClose=${tabsToClose.length}`
      );

      if (tabsToClose.length > 0) {
        // Try the batch close first. If it fails or returns false, fall
        // back to closing each tab individually so a single problem tab
        // doesn't prevent the rest from being cleaned up.
        let batchClosed = false;
        try {
          batchClosed = await vscode.window.tabGroups.close(tabsToClose);
        } catch (error) {
          logWarning(
            `applyEditAndCleanUpTabs: batch close failed (${String(error)}), falling back to per-tab close`
          );
        }
        if (!batchClosed) {
          for (const tab of tabsToClose) {
            try {
              await vscode.window.tabGroups.close(tab);
            } catch (error) {
              logWarning(
                `applyEditAndCleanUpTabs: failed to close tab ${tab.label} (${String(error)})`
              );
            }
          }
        }
      }

      return { applied: true, modifiedFileCount: savedCount };
    }
  );
}

function collectOpenTabPaths(): Set<string> {
  const paths = new Set<string>();
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        paths.add(input.uri.fsPath);
      }
    }
  }
  return paths;
}
