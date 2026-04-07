import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { LinkValidator } from "../diagnostics/linkValidator";
import { logError, logInfo } from "../core/logger";

const SKIP_DIRECTORIES = new Set([
  "Output",
  "Temporary",
  "node_modules",
  ".git",
  ".vs"
]);

const TOPIC_EXTENSIONS = new Set([".htm", ".html"]);

/**
 * Registers the `Flare: Validate All Topics` command. Walks every `.htm` /
 * `.html` topic under the nearest Flare project root and runs the link
 * validator against each one, populating the Problems panel in a single
 * pass. Useful as the primary way to find stale references after files were
 * moved outside VS Code.
 */
export function registerValidateAllTopicsCommand(
  projectResolver: FlareProjectResolver,
  linkValidator: LinkValidator
): vscode.Disposable {
  return vscode.commands.registerCommand("flare.validateAllTopics", async () => {
    const document = vscode.window.activeTextEditor?.document;
    let projectContext = document
      ? await projectResolver.resolveForFile(document.uri).catch(() => undefined)
      : undefined;
    if (!projectContext) {
      // Fall back to the first workspace folder that contains a .flprj.
      const folders = vscode.workspace.workspaceFolders ?? [];
      for (const folder of folders) {
        const probe = await projectResolver
          .resolveForFile(vscode.Uri.joinPath(folder.uri, "placeholder.htm"))
          .catch(() => undefined);
        if (probe) {
          projectContext = probe;
          break;
        }
      }
    }
    if (!projectContext) {
      vscode.window.showWarningMessage(
        "Flare: no .flprj project found in the workspace."
      );
      return;
    }

    const projectRoot = projectContext.projectRoot.fsPath;
    const topicFiles: string[] = [];
    await collectTopics(projectRoot, topicFiles);

    if (topicFiles.length === 0) {
      vscode.window.showInformationMessage(
        "Flare: no topics found under the project root."
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Flare: validating ${topicFiles.length} topic(s)`,
        cancellable: true
      },
      async (progress, token) => {
        const step = 100 / topicFiles.length;
        let validated = 0;
        for (const file of topicFiles) {
          if (token.isCancellationRequested) {
            break;
          }
          try {
            const document = await vscode.workspace.openTextDocument(file);
            await linkValidator.validate(document);
          } catch (error) {
            logError(`Failed to validate ${file}`, error);
          }
          validated += 1;
          progress.report({
            increment: step,
            message: `${validated}/${topicFiles.length} ${path.basename(file)}`
          });
        }
        logInfo(`Validated ${validated} topic(s) under ${projectRoot}.`);
      }
    );
  });
}

async function collectTopics(rootDir: string, accumulator: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("._")) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectTopics(path.join(rootDir, entry.name), accumulator);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (TOPIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      accumulator.push(path.join(rootDir, entry.name));
    }
  }
}
