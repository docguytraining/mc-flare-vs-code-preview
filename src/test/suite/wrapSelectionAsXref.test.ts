import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { WrapSelectionAsXrefProvider } from "../../language/wrapSelectionAsXrefProvider";
import { XrefSnippetCompletionProvider } from "../../language/xrefSnippetCompletionProvider";

async function openHtmTopic(content: string): Promise<vscode.TextDocument> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flare-phase10-"));
  const filePath = path.join(tempDir, "topic.htm");
  await fs.writeFile(filePath, content, "utf8");
  return vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
}

suite("WrapSelectionAsXrefProvider", () => {
  const provider = new WrapSelectionAsXrefProvider();

  test("offers a refactor action for a non-empty plain-text selection", async () => {
    const doc = await openHtmTopic("<p>see also the API</p>");
    const range = new vscode.Range(new vscode.Position(0, 12), new vscode.Position(0, 19));
    const result = provider.provideCodeActions(doc, range);
    assert.ok(result);
    assert.strictEqual(result!.length, 1);
    assert.strictEqual(result![0].title, "Convert to cross-reference…");
    assert.strictEqual(result![0].command?.command, "flare.wrapSelectionAsXref");
  });

  test("returns no action for an empty selection", async () => {
    const doc = await openHtmTopic("<p>hello</p>");
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 3));
    assert.strictEqual(provider.provideCodeActions(doc, range), undefined);
  });

  test("returns no action when the selection contains markup", async () => {
    const doc = await openHtmTopic("<p><strong>API</strong> docs</p>");
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 23));
    assert.strictEqual(provider.provideCodeActions(doc, range), undefined);
  });

  test("returns no action when the selection is whitespace-only", async () => {
    const doc = await openHtmTopic("<p>hello   world</p>");
    const range = new vscode.Range(new vscode.Position(0, 8), new vscode.Position(0, 11));
    assert.strictEqual(provider.provideCodeActions(doc, range), undefined);
  });
});

suite("XrefSnippetCompletionProvider", () => {
  const provider = new XrefSnippetCompletionProvider();

  test("returns three keyword snippets for a Flare topic", async () => {
    const doc = await openHtmTopic("<p>scaffolding</p>");
    const items = provider.provideCompletionItems(doc);
    assert.ok(items);
    const labels = items!.map((item) => item.label);
    assert.deepStrictEqual(labels.sort(), ["cblock", "cond", "xref"]);
    const xref = items!.find((item) => item.label === "xref")!;
    const snippetValue = (xref.insertText as vscode.SnippetString).value;
    assert.match(snippetValue, /<MadCap:xref href="\$1">/);
    assert.match(snippetValue, /<\/MadCap:xref>/);
  });

  test("returns no completions for a non-Flare document", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "x" });
    assert.strictEqual(provider.provideCompletionItems(doc), undefined);
  });
});
