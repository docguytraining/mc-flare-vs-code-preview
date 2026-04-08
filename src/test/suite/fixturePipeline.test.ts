import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { resolveVariables } from "../../flare/variableResolver";
import { resolveStylesheets } from "../../flare/stylesheetResolver";
import { transformMadcapContent } from "../../flare/madcapTransformPipeline";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");
const TOPIC_PATH = path.join(FIXTURE_ROOT, "Content", "Topics", "Overview.htm");

suite("Sample Flare project pipeline", () => {
  let topicUri: vscode.Uri;
  let topicText: string;
  let resolver: FlareProjectResolver;

  suiteSetup(async () => {
    topicUri = vscode.Uri.file(TOPIC_PATH);
    topicText = await fs.readFile(TOPIC_PATH, "utf8");
    resolver = new FlareProjectResolver();
  });

  test("locates the nearest .flprj and variable files", async () => {
    const context = await resolver.resolveForFile(topicUri);
    assert.ok(context, "expected a resolved project context");
    assert.ok(context!.projectFile.fsPath.endsWith("Sample.flprj"));
    assert.ok(context!.variableFiles.some((uri) => uri.fsPath.endsWith("Sample.flvar")));
  });

  test("resolveVariables returns the fixture variables", async () => {
    const context = await resolver.resolveForFile(topicUri);
    const result = await resolveVariables(topicText, context);
    assert.strictEqual(result.variables.get("ProductName"), "Flare Preview");
    assert.strictEqual(result.variables.get("Version"), "1.0.0");
    assert.strictEqual(result.variables.get("Vendor"), "ACME Docs");
    assert.deepStrictEqual(result.unresolvedReferences, []);
  });

  test("resolveStylesheets expands @import into inlined CSS", async () => {
    const context = await resolver.resolveForFile(topicUri);
    const document = await vscode.workspace.openTextDocument(topicUri);
    const bundle = await resolveStylesheets(document, topicText, context);

    const mainCss = bundle.inlinedCss.find((entry) => entry.source.fsPath.endsWith("Main.css"));
    assert.ok(mainCss, "expected Main.css to be inlined");
    assert.ok(mainCss!.content.includes("--flare-accent"), "expected Shared.css contents via @import");
    assert.ok(bundle.stylesheets.length >= 1);
    assert.strictEqual(bundle.missingStylesheets.length, 0);
  });

  test("transformMadcapContent renders variables, conditionals, dropdowns, and snippets", async () => {
    const context = await resolver.resolveForFile(topicUri);
    const variableResult = await resolveVariables(topicText, context);
    const result = await transformMadcapContent(topicText, {
      variables: variableResult.variables,
      projectContext: context,
      currentDocument: topicUri
    });

    assert.ok(result.html.includes("Flare Preview"));
    assert.ok(result.html.includes("1.0.0"));
    assert.ok(result.html.includes("ACME Docs"));
    assert.ok(!result.html.includes("This block must be hidden"));
    assert.ok(result.html.includes("<details"));
    assert.ok(result.html.includes("More details"));
    assert.ok(result.html.includes("Hello from the shared snippet"));
    // breadcrumbsProxy is rendered as a proxy placeholder by the pipeline's
    // proxyPlaceholderTransformHandler — it's a known proxy element, not an
    // unsupported tag — so the placeholder marker is the right thing to look
    // for here.
    assert.ok(result.html.includes("madcap-proxy-placeholder"));
    assert.ok(result.html.includes("breadcrumbsProxy"));
  });
});
