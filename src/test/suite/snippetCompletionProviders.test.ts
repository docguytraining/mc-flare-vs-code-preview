import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { SnippetIndex } from "../../flare/snippetIndex";
import { SnippetBracketCompletionProvider } from "../../language/snippetBracketCompletionProvider";
import { SnippetSrcCompletionProvider } from "../../language/snippetSrcCompletionProvider";

async function makeProject(topicContent: string): Promise<{
  topicUri: vscode.Uri;
  projectRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-snippet-completion-"));
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.mkdir(path.join(root, "Content", "Resources", "Snippets", "Install"), {
    recursive: true
  });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Resources", "Snippets", "intro.flsnp"),
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">\n  <body><p>Welcome.</p></body>\n</html>\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Resources", "Snippets", "Install", "prereqs.flsnp"),
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">\n  <body><p>Prereqs.</p></body>\n</html>\n',
    "utf8"
  );
  const topicPath = path.join(root, "Content", "Topics", "Topic.htm");
  await fs.writeFile(topicPath, topicContent, "utf8");
  return { topicUri: vscode.Uri.file(topicPath), projectRoot: root };
}

suite("SnippetBracketCompletionProvider", () => {
  test("returns one item per snippet when the cursor follows {{", async () => {
    const { topicUri } = await makeProject("<p>see {{</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new SnippetBracketCompletionProvider(
      new FlareProjectResolver(),
      new SnippetIndex()
    );
    const position = new vscode.Position(0, 9); // immediately after `{{`
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    assert.strictEqual(items!.length, 2);
    const labels = items!
      .map((item) => (typeof item.label === "string" ? item.label : item.label.label))
      .sort();
    assert.deepStrictEqual(labels, ["intro", "prereqs"]);
    // Erase the `{{` on accept.
    assert.ok(items![0].range);
    const snippet = items![0].insertText as vscode.SnippetString;
    assert.match(snippet.value, /<MadCap:snippetBlock src="[^"]+" \/>/);
  });

  test("returns nothing when the prior chars are not {{", async () => {
    const { topicUri } = await makeProject("<p>plain prose</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new SnippetBracketCompletionProvider(
      new FlareProjectResolver(),
      new SnippetIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 8));
    assert.strictEqual(items, undefined);
  });

  test("returns nothing when the cursor is inside an open tag", async () => {
    const { topicUri } = await makeProject("<p {{");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new SnippetBracketCompletionProvider(
      new FlareProjectResolver(),
      new SnippetIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 5));
    assert.strictEqual(items, undefined);
  });
});

suite("SnippetSrcCompletionProvider", () => {
  test("returns project snippets when the cursor sits inside a MadCap:snippetBlock src", async () => {
    const { topicUri } = await makeProject('<MadCap:snippetBlock src=""');
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new SnippetSrcCompletionProvider(
      new FlareProjectResolver(),
      new SnippetIndex()
    );
    // Position the cursor between the empty quotes.
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 26));
    assert.ok(items);
    assert.strictEqual(items!.length, 2);
    const inserts = items!.map((item) => item.insertText).sort();
    assert.ok(inserts.some((value) => typeof value === "string" && value.includes("intro.flsnp")));
    assert.ok(
      inserts.some((value) => typeof value === "string" && value.includes("prereqs.flsnp"))
    );
  });

  test("returns nothing for href attributes (xref provider's territory)", async () => {
    const { topicUri } = await makeProject('<MadCap:xref href=""');
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new SnippetSrcCompletionProvider(
      new FlareProjectResolver(),
      new SnippetIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 19));
    assert.strictEqual(items, undefined);
  });
});
