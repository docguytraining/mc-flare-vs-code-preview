import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import {
  VARIABLE_UNRESOLVED_CODE,
  VariableReferenceDiagnostics,
  collectReferences
} from "../../diagnostics/variableReferenceDiagnostics";

async function makeProject(topicContent: string): Promise<vscode.Uri> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-var-diag-"));
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.mkdir(path.join(root, "Project", "VariableSets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "VariableSets", "UI.flvar"),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<CatapultVariableSet>",
      '  <Variable Name="ProductName">Trust Protection Foundation</Variable>',
      "</CatapultVariableSet>",
      ""
    ].join("\n"),
    "utf8"
  );
  const topicPath = path.join(root, "Content", "Topics", "Topic.htm");
  await fs.writeFile(topicPath, topicContent, "utf8");
  return vscode.Uri.file(topicPath);
}

suite("VariableReferenceDiagnostics — collectReferences", () => {
  test("returns one entry per <MadCap:variable> reference with offsets", () => {
    const text = '<p><MadCap:variable name="UI.ProductName" /></p>';
    const refs = collectReferences(text);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].name, "UI.ProductName");
    // Check the offset points at the first character of "UI.ProductName".
    assert.strictEqual(text.slice(refs[0].valueStart, refs[0].valueStart + refs[0].valueLength), "UI.ProductName");
  });

  test("captures multiple references in document order", () => {
    const text = '<p><MadCap:variable name="A.One"/></p><p><MadCap:variable name="B.Two"/></p>';
    const refs = collectReferences(text);
    assert.deepStrictEqual(refs.map((r) => r.name), ["A.One", "B.Two"]);
  });

  test("ignores non-variable MadCap tags", () => {
    const text = '<MadCap:xref href="Other.htm">link</MadCap:xref>';
    assert.deepStrictEqual(collectReferences(text), []);
  });

  test("works with single-quoted name attribute", () => {
    const text = "<MadCap:variable name='UI.X' />";
    const refs = collectReferences(text);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].name, "UI.X");
  });
});

suite("VariableReferenceDiagnostics — refresh", () => {
  test("flags references whose name does not exist in any .flvar", async () => {
    const topicUri = await makeProject(
      '<html><body><p><MadCap:variable name="UI.NoSuchVariable" /></p></body></html>'
    );
    const collection = vscode.languages.createDiagnosticCollection("flare-var-ref-test-1");
    try {
      const provider = new VariableReferenceDiagnostics(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(topicUri);
      await provider.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].code, VARIABLE_UNRESOLVED_CODE);
      assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
      assert.match(diagnostics[0].message, /UI\.NoSuchVariable/);
      // Range must point at the attribute value, not the whole tag.
      const text = document.getText(diagnostics[0].range);
      assert.strictEqual(text, "UI.NoSuchVariable");
    } finally {
      collection.dispose();
    }
  });

  test("does not flag references that resolve via qualified name", async () => {
    const topicUri = await makeProject(
      '<html><body><p><MadCap:variable name="UI.ProductName" /></p></body></html>'
    );
    const collection = vscode.languages.createDiagnosticCollection("flare-var-ref-test-2");
    try {
      const provider = new VariableReferenceDiagnostics(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(topicUri);
      await provider.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 0);
    } finally {
      collection.dispose();
    }
  });

  test("does not flag references that resolve via bare name", async () => {
    const topicUri = await makeProject(
      '<html><body><p><MadCap:variable name="ProductName" /></p></body></html>'
    );
    const collection = vscode.languages.createDiagnosticCollection("flare-var-ref-test-3");
    try {
      const provider = new VariableReferenceDiagnostics(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(topicUri);
      await provider.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 0);
    } finally {
      collection.dispose();
    }
  });

  test("flags multiple unresolved references in the same topic", async () => {
    const topicUri = await makeProject(
      [
        "<html><body>",
        '<p><MadCap:variable name="UI.MissingOne" /></p>',
        '<p><MadCap:variable name="UI.MissingTwo" /></p>',
        '<p><MadCap:variable name="UI.ProductName" /></p>',
        "</body></html>"
      ].join("\n")
    );
    const collection = vscode.languages.createDiagnosticCollection("flare-var-ref-test-4");
    try {
      const provider = new VariableReferenceDiagnostics(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(topicUri);
      await provider.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 2);
      const messages = diagnostics.map((d) => d.message).sort();
      assert.match(messages[0], /UI\.MissingOne/);
      assert.match(messages[1], /UI\.MissingTwo/);
    } finally {
      collection.dispose();
    }
  });

  test("clears diagnostics when the document no longer has any references", async () => {
    const topicUri = await makeProject(
      '<html><body><p><MadCap:variable name="UI.NoSuch" /></p></body></html>'
    );
    const collection = vscode.languages.createDiagnosticCollection("flare-var-ref-test-5");
    try {
      const provider = new VariableReferenceDiagnostics(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(topicUri);
      await provider.refresh(document);
      assert.strictEqual((collection.get(document.uri) ?? []).length, 1);

      // Rewrite the document content via WorkspaceEdit so the in-memory
      // TextDocument is updated. Writing to disk with fs.writeFile and then
      // re-calling openTextDocument is NOT enough — VS Code returns the
      // cached document and provider.refresh would see the stale text.
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(topicUri, fullRange, "<html><body><p>plain</p></body></html>");
      const applied = await vscode.workspace.applyEdit(edit);
      assert.ok(applied, "WorkspaceEdit must apply for the test to be meaningful");
      await provider.refresh(document);
      assert.strictEqual((collection.get(document.uri) ?? []).length, 0);
    } finally {
      collection.dispose();
    }
  });
});
