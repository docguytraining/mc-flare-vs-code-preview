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

/**
 * Captures the fsPaths of every text-bearing tab the user currently has
 * open. Callers should invoke this **at the very start of the command**
 * (before any `vscode.workspace.openTextDocument` calls or any other code
 * path that might surface a file as a tab) and pass the result through to
 * `applyEditAndCleanUpTabs`. Otherwise the snapshot risks treating tabs
 * the command itself opened as "previously open" and preserving them.
 */
export function captureOpenTabPaths(): Set<string> {
  return collectOpenTabPaths();
}

export async function applyEditAndCleanUpTabs(
  edit: vscode.WorkspaceEdit,
  options: {
    progressTitle: string;
    /**
     * Snapshot of the tabs the user had open before the command started.
     * If omitted, the helper takes its own snapshot at call time — but
     * that's only safe for callers that have not yet opened any text
     * documents themselves.
     */
    previouslyOpenPaths?: Set<string>;
  }
): Promise<ApplyAndCloseResult> {
  // Use the caller-supplied snapshot if there is one. Falling back to a
  // late snapshot is convenient for simple callers but produces wrong
  // results for any caller that loaded text documents between command
  // entry and this point — those documents may have surfaced as tabs
  // implicitly and would be wrongly classified as "user already had
  // them open".
  const previouslyOpenPaths = options.previouslyOpenPaths ?? collectOpenTabPaths();

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
      const skippedAlreadyOpen: string[] = [];
      const skippedUnknownType: string[] = [];
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const tabPaths = pathsForTab(tab);
          if (tabPaths.length === 0) {
            // Tab has no associated URI we can match against (output
            // panel, terminal, settings editor, etc.). Skip silently.
            continue;
          }
          // A tab matches if any of its URIs is in the edited set.
          const matchingPath = tabPaths.find((p) => editedPaths.has(p));
          if (matchingPath === undefined) {
            continue;
          }
          if (previouslyOpenPaths.has(matchingPath)) {
            skippedAlreadyOpen.push(matchingPath);
            continue;
          }
          tabsToClose.push(tab);
        }
      }

      // Track edited paths that have NO matching tab at all so we can
      // tell the difference between "tab not found" and "tab found but
      // skipped".
      const matchedPaths = new Set<string>();
      for (const tab of tabsToClose) {
        for (const p of pathsForTab(tab)) {
          if (editedPaths.has(p)) {
            matchedPaths.add(p);
          }
        }
      }
      for (const p of skippedAlreadyOpen) {
        matchedPaths.add(p);
      }
      for (const p of editedPaths) {
        if (!matchedPaths.has(p)) {
          skippedUnknownType.push(p);
        }
      }

      logInfo(
        `applyEditAndCleanUpTabs: edited=${editedPaths.size}, previouslyOpen=${previouslyOpenPaths.size}, tabsToClose=${tabsToClose.length}, skippedAlreadyOpen=${skippedAlreadyOpen.length}, noMatchingTab=${skippedUnknownType.length}`
      );
      if (skippedAlreadyOpen.length > 0 && skippedAlreadyOpen.length <= 20) {
        logInfo(
          `  preserved (already open): ${skippedAlreadyOpen.join(", ")}`
        );
      }
      if (skippedUnknownType.length > 0 && skippedUnknownType.length <= 20) {
        logInfo(
          `  no tab matched (probably written through without tab surfacing): ${skippedUnknownType.join(", ")}`
        );
      }

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
      for (const fsPath of pathsForTab(tab)) {
        paths.add(fsPath);
      }
    }
  }
  return paths;
}

/**
 * Returns every fsPath associated with a tab, regardless of which
 * `TabInput*` flavor the tab uses. We check the full set of input types
 * VS Code exposes:
 *
 *   - `TabInputText` (regular text editor — the common case for .htm,
 *     .fltar, .flcts, .flprj)
 *   - `TabInputCustom` (custom editor view — what an XML extension
 *     might register for .fltar files)
 *   - `TabInputNotebook` (Jupyter / interactive notebook)
 *   - `TabInputTextDiff` (diff view, has both `original` and `modified`
 *     URIs — we return both)
 *   - `TabInputNotebookDiff` (notebook diff, same shape)
 *
 * Tabs with no associated URI (terminal, output, settings, etc.) return
 * an empty array. Casing this way means we never silently skip a tab
 * just because it happens to use a less-common input type — the previous
 * version of the helper only checked Text and Custom, which is why
 * `.fltar` target files surfaced as some other tab type were never
 * being closed.
 */
function pathsForTab(tab: vscode.Tab): string[] {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return [input.uri.fsPath];
  }
  if (input instanceof vscode.TabInputCustom) {
    return [input.uri.fsPath];
  }
  if (input instanceof vscode.TabInputNotebook) {
    return [input.uri.fsPath];
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return [input.original.fsPath, input.modified.fsPath];
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    return [input.original.fsPath, input.modified.fsPath];
  }
  return [];
}
