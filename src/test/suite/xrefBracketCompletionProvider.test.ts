import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { TopicIndex } from "../../flare/topicIndex";
import { XrefBracketCompletionProvider } from "../../language/xrefBracketCompletionProvider";

async function makeProject(activeTopicContent: string): Promise<vscode.Uri> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-xref-bracket-"));
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Topics", "Other.htm"),
    "<html><body><h1>Another Topic</h1><p>body</p></body></html>",
    "utf8"
  );
  const activePath = path.join(root, "Content", "Topics", "Active.htm");
  await fs.writeFile(activePath, activeTopicContent, "utf8");
  return vscode.Uri.file(activePath);
}

suite("XrefBracketCompletionProvider", () => {
  test("returns one item per project topic when [[ precedes the cursor", async () => {
    const topicUri = await makeProject("<p>see [[</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    const position = new vscode.Position(0, 9);
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    // Both Active.htm and Other.htm are in the project.
    assert.strictEqual(items!.length, 2);
    const labels = items!
      .map((item) => (typeof item.label === "string" ? item.label : item.label.label))
      .sort();
    assert.ok(labels.includes("Another Topic"));
    const snippet = items![0].insertText as vscode.SnippetString;
    assert.match(snippet.value, /<MadCap:xref href="[^"]+">/);
    assert.match(snippet.value, /<\/MadCap:xref>/);
    // Erase the [[ on accept.
    assert.ok(items![0].range);
  });

  test("returns nothing when the prior chars are not [[", async () => {
    const topicUri = await makeProject("<p>plain prose</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 7));
    assert.strictEqual(items, undefined);
  });

  test("returns nothing when [[ appears inside an open tag", async () => {
    const topicUri = await makeProject("<p [[");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 5));
    assert.strictEqual(items, undefined);
  });
});
