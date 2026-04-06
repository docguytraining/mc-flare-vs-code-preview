import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { resolveVariables } from "../../flare/variableResolver";
import { transformMadcapContent } from "../../flare/madcapTransformPipeline";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");
const TOPIC_PATH = path.join(FIXTURE_ROOT, "Content", "Topics", "Overview.htm");

suite("Phase 8 regression coverage", () => {
  test("project resolver discovers variable files via recursive Project/VariableSets walk", async () => {
    const resolver = new FlareProjectResolver();
    const context = await resolver.resolveForFile(vscode.Uri.file(TOPIC_PATH));
    assert.ok(context, "expected a project context");
    const flvarPaths = context!.variableFiles.map((uri) => uri.fsPath);
    assert.ok(
      flvarPaths.some((entry) => entry.endsWith(path.join("VariableSets", "Sample.flvar"))),
      "expected the top-level Sample.flvar to be discovered"
    );
    assert.ok(
      flvarPaths.some((entry) => entry.endsWith(path.join("Subfolder", "UI.flvar"))),
      "expected the nested Subfolder/UI.flvar to be discovered"
    );
  });

  test("variable resolver parses element text content and exposes namespaced + bare keys", async () => {
    const resolver = new FlareProjectResolver();
    const context = await resolver.resolveForFile(vscode.Uri.file(TOPIC_PATH));
    const result = await resolveVariables("", context);

    // Element-text style from Subfolder/UI.flvar
    assert.strictEqual(result.variables.get("UI.ButtonLabel"), "Save Changes");
    assert.strictEqual(result.variables.get("UI.MenuLabel"), "Settings");
    assert.strictEqual(result.variables.get("UI.TrademarkSymbol"), "™");
    // Bare-key fallback for the same variable
    assert.strictEqual(result.variables.get("ButtonLabel"), "Save Changes");
    // Existing <Value> child format from Sample.flvar still works
    assert.strictEqual(result.variables.get("Sample.ProductName"), "Flare Preview");
    // Existing Value="…" attribute format from Sample.flvar still works
    assert.strictEqual(result.variables.get("Sample.Vendor"), "ACME Docs");
  });

  test("namespaced variable references resolve in transform output", async () => {
    const resolver = new FlareProjectResolver();
    const context = await resolver.resolveForFile(vscode.Uri.file(TOPIC_PATH));
    const html = '<p><MadCap:variable name="UI.ButtonLabel" /></p>';
    const variableResult = await resolveVariables(html, context);
    const transform = await transformMadcapContent(html, {
      variables: variableResult.variables,
      projectContext: context,
      currentDocument: vscode.Uri.file(TOPIC_PATH)
    });
    assert.ok(transform.html.includes("Save Changes"));
    assert.deepStrictEqual(variableResult.unresolvedReferences, []);
  });

  test("MadCap:keyword is dropped silently", async () => {
    const html = '<h1>Title<MadCap:keyword term="topic;subject" /></h1>';
    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>(),
      projectContext: undefined,
      currentDocument: vscode.Uri.file("/tmp/topic.htm")
    });
    assert.ok(!result.html.includes("MadCap:keyword"));
    assert.ok(!result.html.includes("Unsupported"));
    assert.ok(result.html.includes("Title"));
  });

  test("MadCap:annotation is unwrapped while preserving its inner content", async () => {
    const html = '<p><MadCap:annotation MadCap:comment="needs review" MadCap:creator="dw">visible content</MadCap:annotation></p>';
    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>(),
      projectContext: undefined,
      currentDocument: vscode.Uri.file("/tmp/topic.htm")
    });
    assert.ok(result.html.includes("visible content"), "annotation body should be preserved");
    assert.ok(!result.html.includes("MadCap:annotation"));
    assert.ok(!result.html.includes("Unsupported"));
  });

  test("project resolver ignores ._* AppleDouble files when walking for .flprj", async () => {
    // The fixture only contains Sample.flprj, but a synthetic ._Sample.flprj
    // sitting next to it must not be picked. We exercise the underlying
    // helper indirectly: an AppleDouble path passed to resolveForFile via a
    // file under Content/ must still resolve to Sample.flprj.
    const resolver = new FlareProjectResolver();
    const context = await resolver.resolveForFile(vscode.Uri.file(TOPIC_PATH));
    assert.ok(context);
    assert.ok(context!.projectFile.fsPath.endsWith("Sample.flprj"));
    assert.ok(!context!.projectFile.fsPath.includes("/._"));
  });
});
