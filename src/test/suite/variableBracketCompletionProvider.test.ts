import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { VariableIndex } from "../../flare/variableIndex";
import { VariableBracketCompletionProvider } from "../../language/variableBracketCompletionProvider";

async function makeProject(activeTopicContent: string): Promise<vscode.Uri> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-variable-bracket-"));
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.mkdir(path.join(root, "Project", "VariableSets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "VariableSets", "UI.flvar"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultVariableSet>\n  <Variable Name="ProductName">Trust Protection Foundation</Variable>\n  <Variable Name="CompanyName">DocGuy Training</Variable>\n</CatapultVariableSet>\n',
    "utf8"
  );
  const activePath = path.join(root, "Content", "Topics", "Active.htm");
  await fs.writeFile(activePath, activeTopicContent, "utf8");
  return vscode.Uri.file(activePath);
}

suite("VariableBracketCompletionProvider", () => {
  test("returns one item per variable when @@ precedes the cursor", async () => {
    const topicUri = await makeProject("<p>see @@</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new VariableBracketCompletionProvider(
      new FlareProjectResolver(),
      new VariableIndex()
    );
    const position = new vscode.Position(0, 9);
    const items = await provider.provideCompletionItems(document, position);
    assert.ok(items);
    assert.strictEqual(items!.length, 2);
    const labels = items!
      .map((item) => (typeof item.label === "string" ? item.label : item.label.label))
      .sort();
    assert.deepStrictEqual(labels, ["UI.CompanyName", "UI.ProductName"]);
    const snippet = items![0].insertText as vscode.SnippetString;
    assert.match(snippet.value, /<MadCap:variable name="UI\.[^"]+" \/>/);
    // Erase the @@ on accept.
    assert.ok(items![0].range);
  });

  test("filterText lets authors filter by either name or value", async () => {
    const topicUri = await makeProject("<p>@@</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new VariableBracketCompletionProvider(
      new FlareProjectResolver(),
      new VariableIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 5));
    assert.ok(items);
    const product = items!.find((item) => {
      const label = typeof item.label === "string" ? item.label : item.label.label;
      return label === "UI.ProductName";
    });
    assert.ok(product);
    assert.ok(product!.filterText);
    assert.ok(product!.filterText!.includes("UI.ProductName"));
    assert.ok(product!.filterText!.includes("Trust Protection Foundation"));
  });

  test("returns nothing when the prior chars are not @@", async () => {
    const topicUri = await makeProject("<p>plain prose</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new VariableBracketCompletionProvider(
      new FlareProjectResolver(),
      new VariableIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 7));
    assert.strictEqual(items, undefined);
  });

  test("returns nothing when @@ appears inside an open tag", async () => {
    const topicUri = await makeProject("<p @@");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new VariableBracketCompletionProvider(
      new FlareProjectResolver(),
      new VariableIndex()
    );
    const items = await provider.provideCompletionItems(document, new vscode.Position(0, 5));
    assert.strictEqual(items, undefined);
  });
});
