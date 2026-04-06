import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { VariableSuggestionEngine } from "../../language/variableSuggestionEngine";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");

suite("VariableSuggestionEngine", () => {
  test("flags literal text that matches a known variable value", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-suggestion.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>Published by ACME Docs for all customers.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-suggestion-test");
    try {
      const engine = new VariableSuggestionEngine(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await engine.refresh(document);

      const diagnostics = collection.get(document.uri) ?? [];
      const hit = diagnostics.find(
        (diagnostic) => diagnostic.code === VariableSuggestionEngine.diagnosticCode
      );
      assert.ok(hit, "expected a suggestion diagnostic for 'ACME Docs'");
      assert.ok(hit!.message.includes("Vendor"), "expected the Vendor variable to be named");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });

  test("does not flag literals inside existing MadCap tags", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-noise.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p><MadCap:variable name=\"Vendor\" /> already tagged.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-suggestion-noise");
    try {
      const engine = new VariableSuggestionEngine(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await engine.refresh(document);

      const diagnostics = collection.get(document.uri) ?? [];
      assert.strictEqual(diagnostics.length, 0, "existing MadCap tags should not trigger suggestions");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });
});
