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

  test("returns the full keyword snippet set for a Flare topic", async () => {
    const doc = await openHtmTopic("<p>scaffolding</p>");
    const items = provider.provideCompletionItems(doc);
    assert.ok(items);
    const labels = items!.map((item) => item.label);
    assert.deepStrictEqual(
      labels.sort(),
      ["cblock", "cond", "snip", "snipblock", "xref"]
    );
    const xref = items!.find((item) => item.label === "xref")!;
    const xrefSnippet = (xref.insertText as vscode.SnippetString).value;
    assert.match(xrefSnippet, /<MadCap:xref href="\$1">/);
    assert.match(xrefSnippet, /<\/MadCap:xref>/);
    const snip = items!.find((item) => item.label === "snip")!;
    assert.match((snip.insertText as vscode.SnippetString).value, /<MadCap:snippet src="\$1" \/>/);
    const snipblock = items!.find((item) => item.label === "snipblock")!;
    assert.match(
      (snipblock.insertText as vscode.SnippetString).value,
      /<MadCap:snippetBlock src="\$1" \/>/
    );
  });

  test("returns no completions for a non-Flare document", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "x" });
    assert.strictEqual(provider.provideCompletionItems(doc), undefined);
  });
});
