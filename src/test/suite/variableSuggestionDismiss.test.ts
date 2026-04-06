import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import {
  VariableSuggestionEngine,
  buildDismissMarkerEdit,
  readDocumentIgnoreMarkers
} from "../../language/variableSuggestionEngine";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");

suite("VariableSuggestionEngine - dismissals + case sensitivity", () => {
  test("readDocumentIgnoreMarkers parses single and multi-name comments", () => {
    const text = [
      "<html>",
      "  <body>",
      "    <!-- flare:no-suggest UI.user -->",
      "    <!-- flare:no-suggest _Variables-Generic.Vendor, _Variables-Generic.ProductName -->",
      "  </body>",
      "</html>"
    ].join("\n");
    const result = readDocumentIgnoreMarkers(text);
    assert.deepStrictEqual(
      result.sort(),
      ["UI.user", "_Variables-Generic.ProductName", "_Variables-Generic.Vendor"].sort()
    );
  });

  test("buildDismissMarkerEdit inserts a marker after the opening <body> tag", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-dismiss.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>Hello world.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      const edit = buildDismissMarkerEdit(document, "UI.user");
      const applied = await vscode.workspace.applyEdit(edit);
      assert.ok(applied);
      const updated = document.getText();
      assert.ok(updated.includes("<!-- flare:no-suggest UI.user -->"));
      const markerIndex = updated.indexOf("<!-- flare:no-suggest UI.user -->");
      const bodyIndex = updated.indexOf("<body>");
      assert.ok(markerIndex > bodyIndex, "marker should land after the opening <body>");
    } finally {
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });

  test("case-sensitive matching: lowercased prose does not trigger an uppercased variable", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-case.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>The acme docs team is responsible for documentation.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-case-test");
    try {
      const engine = new VariableSuggestionEngine(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await engine.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      // The fixture defines Vendor = "ACME Docs" (uppercased), so a lowercase
      // "acme docs" must NOT match under the new case-sensitive rule.
      const hit = diagnostics.find(
        (diagnostic) => diagnostic.code === VariableSuggestionEngine.diagnosticCode
      );
      assert.strictEqual(hit, undefined, "lowercased prose should not match an uppercased variable");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });

  test("inline marker suppresses suggestions for the named variable in that document", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-marker.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <!-- flare:no-suggest Vendor -->",
        "    <p>Published by ACME Docs.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-marker-test");
    try {
      const engine = new VariableSuggestionEngine(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await engine.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 0, "marker should suppress all suggestions for Vendor");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });
});
