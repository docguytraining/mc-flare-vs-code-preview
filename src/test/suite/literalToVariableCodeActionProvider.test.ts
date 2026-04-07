import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { VariableIndex } from "../../flare/variableIndex";
import { LiteralToVariableCodeActionProvider } from "../../language/literalToVariableCodeActionProvider";

async function makeProject(activeTopicContent: string): Promise<vscode.Uri> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-literal-to-var-"));
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
  await fs.writeFile(
    path.join(root, "Project", "VariableSets", "Alt.flvar"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultVariableSet>\n  <Variable Name="Brand">DocGuy Training</Variable>\n</CatapultVariableSet>\n',
    "utf8"
  );
  const activePath = path.join(root, "Content", "Topics", "Active.htm");
  await fs.writeFile(activePath, activeTopicContent, "utf8");
  return vscode.Uri.file(activePath);
}

function makeProvider(): LiteralToVariableCodeActionProvider {
  return new LiteralToVariableCodeActionProvider(
    new FlareProjectResolver(),
    new VariableIndex()
  );
}

suite("LiteralToVariableCodeActionProvider", () => {
  test("offers a single-match action naming the variable", async () => {
    const topicUri = await makeProject("<p>Trust Protection Foundation</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 30));
    assert.strictEqual(document.getText(range), "Trust Protection Foundation");
    const actions = await provider.provideCodeActions(document, range);
    assert.ok(actions);
    assert.strictEqual(actions!.length, 1);
    assert.ok(actions![0].title.includes("UI.ProductName"));
    assert.strictEqual(actions![0].command?.command, "flare.replaceSelectionWithVariable");
    const args = actions![0].command?.arguments ?? [];
    assert.strictEqual(args[2], "UI.ProductName");
  });

  test("offers a multi-match action without preselecting a name", async () => {
    const topicUri = await makeProject("<p>DocGuy Training</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 18));
    assert.strictEqual(document.getText(range), "DocGuy Training");
    const actions = await provider.provideCodeActions(document, range);
    assert.ok(actions);
    assert.strictEqual(actions!.length, 1);
    assert.ok(actions![0].title.includes("2 matches"));
    const args = actions![0].command?.arguments ?? [];
    assert.strictEqual(args[2], undefined);
  });

  test("ignores surrounding whitespace on the selection", async () => {
    const topicUri = await makeProject("<p>  Trust Protection Foundation  </p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 34));
    const actions = await provider.provideCodeActions(document, range);
    assert.ok(actions);
    assert.strictEqual(actions!.length, 1);
  });

  test("returns nothing for a selection with no matching variable", async () => {
    const topicUri = await makeProject("<p>Nothing to see here</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 22));
    const actions = await provider.provideCodeActions(document, range);
    assert.strictEqual(actions, undefined);
  });

  test("returns nothing for an empty selection", async () => {
    const topicUri = await makeProject("<p>Trust Protection Foundation</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 3));
    const actions = await provider.provideCodeActions(document, range);
    assert.strictEqual(actions, undefined);
  });

  test("returns nothing for a selection containing markup", async () => {
    const topicUri = await makeProject("<p><b>Trust Protection Foundation</b></p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = makeProvider();
    // Selection includes the <b> and </b> tags.
    const range = new vscode.Range(new vscode.Position(0, 3), new vscode.Position(0, 37));
    assert.ok(document.getText(range).includes("<b>"));
    const actions = await provider.provideCodeActions(document, range);
    assert.strictEqual(actions, undefined);
  });
});
