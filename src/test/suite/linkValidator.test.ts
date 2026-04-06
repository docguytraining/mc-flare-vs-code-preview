import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { LinkValidator } from "../../diagnostics/linkValidator";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");
const INSTALLATION_TOPIC = path.join(FIXTURE_ROOT, "Content", "Topics", "Installation.htm");

suite("LinkValidator", () => {
  test("reports a broken local link and leaves valid xrefs alone", async () => {
    const collection = vscode.languages.createDiagnosticCollection("flare-links-test");
    try {
      const validator = new LinkValidator(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(INSTALLATION_TOPIC));
      await validator.validate(document);

      const diagnostics = collection.get(document.uri) ?? [];
      const brokenLink = diagnostics.find((diagnostic) => diagnostic.code === "flare.link-missing");
      assert.ok(brokenLink, "expected a broken-link diagnostic for DoesNotExist.htm");
      assert.ok(brokenLink!.message.includes("DoesNotExist.htm"));

      const validXref = diagnostics.find(
        (diagnostic) =>
          typeof diagnostic.code === "string" && diagnostic.code.startsWith("flare.") &&
          diagnostic.message.includes("Overview.htm")
      );
      assert.strictEqual(validXref, undefined, "Overview.htm xref should validate cleanly");
    } finally {
      collection.dispose();
    }
  });

  test("flags missing anchors inside an existing target topic", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-xref.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html xmlns:MadCap=\"http://www.madcapsoftware.com/Schemas/MadCap.xsd\">",
        "  <body>",
        "    <p><MadCap:xref href=\"Overview.htm#does-not-exist\">broken</MadCap:xref></p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-anchor-test");
    try {
      const validator = new LinkValidator(collection, new FlareProjectResolver());
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await validator.validate(document);

      const diagnostics = collection.get(document.uri) ?? [];
      const anchorMissing = diagnostics.find((diagnostic) => diagnostic.code === "flare.anchor-missing");
      assert.ok(anchorMissing, "expected an anchor-missing diagnostic for Overview.htm#does-not-exist");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });
});
