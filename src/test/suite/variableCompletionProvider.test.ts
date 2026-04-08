import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { DismissalStore } from "../../diagnostics/dismissalStore";
import { VariableCompletionProvider } from "../../language/variableCompletionProvider";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");

interface CompletionInput {
  html: string;
  cursorMarker?: string;
}

// Each test uses its own scratch file because vscode.workspace.openTextDocument
// caches by URI — re-opening the same path returns the cached document with
// the previous test's content, even after fs.writeFile updates the bytes on
// disk. The scratchPaths set tracks every file we created so the suite-level
// teardown can delete them all.
let scratchCounter = 0;
const scratchPaths = new Set<string>();

/**
 * Writes a scratch topic under the sample project containing the given HTML
 * with `|` marking the desired cursor position, opens it, runs the provider,
 * and returns the completion items plus the cursor position.
 */
async function runCompletion(input: CompletionInput): Promise<{
  items: vscode.CompletionItem[] | undefined;
  document: vscode.TextDocument;
  cursor: vscode.Position;
}> {
  const marker = input.cursorMarker ?? "|";
  const cursorIndex = input.html.indexOf(marker);
  if (cursorIndex < 0) {
    throw new Error("test setup: cursor marker not found in html");
  }
  const source = input.html.replace(marker, "");
  scratchCounter += 1;
  const scratchPath = path.join(
    FIXTURE_ROOT,
    "Content",
    "Topics",
    `__scratch-completion-${scratchCounter}.htm`
  );
  scratchPaths.add(scratchPath);
  await fs.writeFile(scratchPath, source, "utf8");

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
  const cursor = document.positionAt(cursorIndex);

  const provider = new VariableCompletionProvider(new FlareProjectResolver(), new DismissalStore());
  const items = await provider.provideCompletionItems(
    document,
    cursor,
    new vscode.CancellationTokenSource().token,
    { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined }
  );
  return { items: items as vscode.CompletionItem[] | undefined, document, cursor };
}

async function cleanup(): Promise<void> {
  for (const scratchPath of scratchPaths) {
    await fs.unlink(scratchPath).catch(() => undefined);
  }
  scratchPaths.clear();
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

suite("VariableCompletionProvider - value-prefix completion", () => {
  test("suggests a variable when the typed word begins with its value (start of paragraph)", async () => {
    try {
      const { items } = await runCompletion({
        html: "<html><body><p>Flare|</p></body></html>"
      });
      assert.ok(items && items.length > 0, "expected at least one completion for the first word of a value");
      const labels = items!.map(labelOf);
      assert.ok(
        labels.some((label) => label.startsWith("Flare Preview")),
        "expected Flare Preview value to appear"
      );
    } finally {
      await cleanup();
    }
  });

  test("suggests a variable when the typed word is mid-paragraph after existing prose (regression)", async () => {
    try {
      const { items } = await runCompletion({
        html: "<html><body><p>The quick brown fox and then Flare|</p></body></html>"
      });
      assert.ok(
        items && items.length > 0,
        "expected a completion even when the word being typed is mid-paragraph"
      );
      const labels = items!.map(labelOf);
      assert.ok(
        labels.some((label) => label.startsWith("Flare Preview")),
        "expected Flare Preview value to appear for a mid-paragraph prefix"
      );
    } finally {
      await cleanup();
    }
  });

  test("prefers a longer multi-word match over a single-word match", async () => {
    try {
      // "ACME Docs" is the Vendor value in the fixture; a single-word
      // candidate "Docs" would not match anything, but "ACME Docs" as a
      // two-word candidate does.
      const { items } = await runCompletion({
        html: "<html><body><p>Published by ACME Docs|</p></body></html>"
      });
      assert.ok(items && items.length > 0);
      const labels = items!.map(labelOf);
      assert.ok(labels.some((label) => label.startsWith("ACME Docs")));
    } finally {
      await cleanup();
    }
  });

  test("does not fire inside an HTML tag", async () => {
    try {
      const { items } = await runCompletion({
        html: "<html><body><p class=\"Flare|\"></p></body></html>"
      });
      // Inside a class attribute we should not return value-prefix completions.
      // The provider may return undefined, or an empty list — both are fine.
      if (items) {
        const labels = items.map(labelOf);
        assert.ok(
          !labels.some((label) => label.startsWith("Flare Preview")),
          "should not suggest Flare Preview inside an attribute value"
        );
      }
    } finally {
      await cleanup();
    }
  });

  test("does not fire when the prefix ends in whitespace", async () => {
    try {
      const { items } = await runCompletion({
        html: "<html><body><p>Flare |</p></body></html>"
      });
      if (items) {
        const labels = items.map(labelOf);
        assert.ok(
          !labels.some((label) => label.startsWith("Flare Preview")),
          "should not suggest after a completed word"
        );
      }
    } finally {
      await cleanup();
    }
  });
});
