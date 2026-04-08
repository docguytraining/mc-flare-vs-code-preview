import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConditionCompletionProvider } from "../../language/conditionCompletionProvider";
import { ConditionTagIndex } from "../../flare/conditionTagIndex";
import { FlareProjectResolver } from "../../core/flareProjectResolver";

const FLCTS = `<?xml version="1.0" encoding="utf-8"?>
<CatapultConditionTagSet>
  <ConditionTag Name="Public" BackgroundColor="#4caf50" Comment="public-facing" />
  <ConditionTag Name="Internal" Comment="not for customers" />
</CatapultConditionTagSet>
`;

async function makeProject(activeTopicContent: string): Promise<vscode.Uri> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-cond-completion-"));
  await fs.mkdir(path.join(root, "Project", "ConditionTagSets"), { recursive: true });
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "ConditionTagSets", "Default.flcts"),
    FLCTS,
    "utf8"
  );
  const topicPath = path.join(root, "Content", "Topics", "Active.htm");
  await fs.writeFile(topicPath, activeTopicContent, "utf8");
  return vscode.Uri.file(topicPath);
}

function newProvider(): ConditionCompletionProvider {
  return new ConditionCompletionProvider(
    new FlareProjectResolver(),
    new ConditionTagIndex()
  );
}

suite("ConditionCompletionProvider", () => {
  test("returns Color-kind items with hex documentation for tags that declare a color", async () => {
    const topicUri = await makeProject('<p MadCap:conditions="">x</p>');
    const document = await vscode.workspace.openTextDocument(topicUri);
    // Position cursor inside the empty quoted attribute value.
    const position = new vscode.Position(0, 22);
    const items = await newProvider().provideCompletionItems(document, position);
    assert.ok(items, "expected completions inside MadCap:conditions=\"\"");
    const publicItem = items!.find((item) => item.label === "Default.Public");
    assert.ok(publicItem, "Default.Public should be offered");
    assert.strictEqual(publicItem!.kind, vscode.CompletionItemKind.Color);
    // VS Code reads the swatch hex out of `documentation` (must be a string).
    assert.strictEqual(publicItem!.documentation, "#4caf50");
    // Detail surfaces the description so the swatch can own `documentation`.
    assert.ok(typeof publicItem!.detail === "string");
    assert.ok((publicItem!.detail as string).includes("public-facing"));
  });

  test("falls back to EnumMember + MarkdownString documentation when no color is set", async () => {
    const topicUri = await makeProject('<p MadCap:conditions="">x</p>');
    const document = await vscode.workspace.openTextDocument(topicUri);
    const items = await newProvider().provideCompletionItems(document, new vscode.Position(0, 22));
    assert.ok(items);
    const internalItem = items!.find((item) => item.label === "Default.Internal");
    assert.ok(internalItem, "Default.Internal should be offered");
    assert.strictEqual(internalItem!.kind, vscode.CompletionItemKind.EnumMember);
    assert.ok(internalItem!.documentation instanceof vscode.MarkdownString);
    const md = (internalItem!.documentation as vscode.MarkdownString).value;
    assert.ok(md.includes("Default.Internal"));
    assert.ok(md.includes("not for customers"));
  });

  test("re-triggers IntelliSense after acceptance so the next tag can be picked without retyping", async () => {
    const topicUri = await makeProject('<p MadCap:conditions="">x</p>');
    const document = await vscode.workspace.openTextDocument(topicUri);
    const items = await newProvider().provideCompletionItems(document, new vscode.Position(0, 22));
    assert.ok(items);
    for (const item of items!) {
      assert.strictEqual(item.command?.command, "editor.action.triggerSuggest");
    }
  });

  test("returns undefined outside of a MadCap:conditions attribute", async () => {
    const topicUri = await makeProject("<p>plain prose</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const items = await newProvider().provideCompletionItems(document, new vscode.Position(0, 5));
    assert.strictEqual(items, undefined);
  });

  test("also fires inside MadCap:conditionTagExpression attributes", async () => {
    const topicUri = await makeProject(
      '<MadCap:conditionalText MadCap:conditionTagExpression="">y</MadCap:conditionalText>'
    );
    const document = await vscode.workspace.openTextDocument(topicUri);
    // Cursor inside the empty conditionTagExpression="" (column 55 is just past the opening ").
    const position = new vscode.Position(0, 55);
    const items = await newProvider().provideCompletionItems(document, position);
    assert.ok(items);
    assert.ok(items!.some((item) => item.label === "Default.Public"));
  });
});
