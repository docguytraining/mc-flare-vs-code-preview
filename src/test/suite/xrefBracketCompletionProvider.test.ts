import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { TopicIndex } from "../../flare/topicIndex";
import {
  XrefBracketCompletionProvider,
  expandRangeOverTrailingCloseBrackets
} from "../../language/xrefBracketCompletionProvider";

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

  // Issue 1 — auto-close brackets leak ]] after the inserted xref unless
  // we extend the replacement range to swallow them.
  test("replace range covers the auto-closed ]] when the cursor sits between [[ and ]]", async () => {
    // VS Code's HTML auto-closer turns the user typing `[[` into `[[]]`
    // with the cursor between the two halves. The completion item must
    // therefore replace `[[]]`, not just `[[`, otherwise the rendered
    // xref tag is followed by stray `]]` characters.
    const topicUri = await makeProject("<p>see [[]]</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    // Position 9 is between `[[` and `]]` in `<p>see [[]]</p>`.
    const position = new vscode.Position(0, 9);
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    assert.ok(items!.length > 0);
    const range = items![0].range as vscode.Range;
    assert.ok(range, "completion item should carry an explicit replace range");
    assert.strictEqual(range.start.character, 7, "range starts at the first [");
    assert.strictEqual(range.end.character, 11, "range ends after the second ]");
  });

  test("replace range covers a single trailing ] when only one ] was auto-closed", async () => {
    const topicUri = await makeProject("<p>see [[]</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    const position = new vscode.Position(0, 9);
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    const range = items![0].range as vscode.Range;
    assert.strictEqual(range.start.character, 7);
    assert.strictEqual(range.end.character, 10);
  });

  test("replace range stays at the cursor when no auto-closed ] follows", async () => {
    const topicUri = await makeProject("<p>see [[</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new XrefBracketCompletionProvider(
      new FlareProjectResolver(),
      new TopicIndex()
    );
    const position = new vscode.Position(0, 9);
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    const range = items![0].range as vscode.Range;
    assert.strictEqual(range.start.character, 7);
    assert.strictEqual(range.end.character, 9, "no closer to consume");
  });

  // Pure helper unit tests so the behavior is verifiable without standing
  // up a topic + project fixture.
  suite("expandRangeOverTrailingCloseBrackets", () => {
    test("consumes up to two trailing close brackets", async () => {
      const topicUri = await makeProject("xx[[]]");
      const document = await vscode.workspace.openTextDocument(topicUri);
      const cursor = new vscode.Position(0, 4);
      const baseRange = new vscode.Range(new vscode.Position(0, 2), cursor);
      const expanded = expandRangeOverTrailingCloseBrackets(document, cursor, baseRange);
      assert.strictEqual(expanded.start.character, 2);
      assert.strictEqual(expanded.end.character, 6);
    });

    test("consumes one trailing close brace as well as bracket", async () => {
      const topicUri = await makeProject("xx{{}");
      const document = await vscode.workspace.openTextDocument(topicUri);
      const cursor = new vscode.Position(0, 4);
      const baseRange = new vscode.Range(new vscode.Position(0, 2), cursor);
      const expanded = expandRangeOverTrailingCloseBrackets(document, cursor, baseRange);
      assert.strictEqual(expanded.end.character, 5);
    });

    test("returns the input range unchanged when nothing follows the cursor", async () => {
      const topicUri = await makeProject("xx[[");
      const document = await vscode.workspace.openTextDocument(topicUri);
      const cursor = new vscode.Position(0, 4);
      const baseRange = new vscode.Range(new vscode.Position(0, 2), cursor);
      const expanded = expandRangeOverTrailingCloseBrackets(document, cursor, baseRange);
      assert.strictEqual(expanded.end.character, 4);
    });

    test("does not consume an unrelated trailing character", async () => {
      const topicUri = await makeProject("xx[[abc");
      const document = await vscode.workspace.openTextDocument(topicUri);
      const cursor = new vscode.Position(0, 4);
      const baseRange = new vscode.Range(new vscode.Position(0, 2), cursor);
      const expanded = expandRangeOverTrailingCloseBrackets(document, cursor, baseRange);
      assert.strictEqual(expanded.end.character, 4);
    });
  });
});
