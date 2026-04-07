import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ExtractSnippetCodeActionProvider,
  hasBalancedTags
} from "../../language/extractSnippetCodeActionProvider";

async function openHtmTopic(content: string): Promise<vscode.TextDocument> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flare-extract-"));
  const file = path.join(dir, "topic.htm");
  await fs.writeFile(file, content, "utf8");
  return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}

suite("hasBalancedTags", () => {
  test("returns true for plain text with no tags", () => {
    assert.strictEqual(hasBalancedTags("just some prose"), true);
  });

  test("returns true for a balanced single element", () => {
    assert.strictEqual(hasBalancedTags("<p>hello</p>"), true);
  });

  test("returns true for nested balanced elements", () => {
    assert.strictEqual(
      hasBalancedTags("<div><p>hello <strong>world</strong></p></div>"),
      true
    );
  });

  test("returns true for self-closing void elements", () => {
    assert.strictEqual(hasBalancedTags("<p>line<br />break</p>"), true);
  });

  test("returns false for an unmatched opening tag", () => {
    assert.strictEqual(hasBalancedTags("<p>hello"), false);
  });

  test("returns false for an unmatched closing tag", () => {
    assert.strictEqual(hasBalancedTags("hello</p>"), false);
  });

  test("returns false for mismatched element names", () => {
    assert.strictEqual(hasBalancedTags("<p>hello</div>"), false);
  });

  test("returns false for an unbalanced angle-bracket count", () => {
    assert.strictEqual(hasBalancedTags("<p>oops"), false);
  });
});

suite("ExtractSnippetCodeActionProvider", () => {
  const provider = new ExtractSnippetCodeActionProvider();

  test("offers an extract action for a balanced multi-line selection", async () => {
    const doc = await openHtmTopic("<body>\n  <p>Hello</p>\n  <p>World</p>\n</body>");
    const range = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(2, 13));
    const result = provider.provideCodeActions(doc, range);
    assert.ok(result);
    assert.strictEqual(result!.length, 1);
    assert.strictEqual(result![0].command?.command, "flare.extractSelectionAsSnippet");
  });

  test("returns no action for an empty selection", async () => {
    const doc = await openHtmTopic("<p>hello</p>");
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 3));
    assert.strictEqual(provider.provideCodeActions(doc, range), undefined);
  });

  test("returns no action when the selection has unbalanced tags", async () => {
    const doc = await openHtmTopic("<p>hello world</p>");
    // Range cuts through the closing tag.
    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 12));
    assert.strictEqual(provider.provideCodeActions(doc, range), undefined);
  });
});
