import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { transformMadcapContent } from "../../flare/madcapTransformPipeline";

suite("MadCap Transform Pipeline", () => {
  test("resolves variables and token variables", async () => {
    const html = [
      "<p><MadCap:variable name=\"ProductName\" /></p>",
      "<p>${BuildVersion}</p>",
      "<p><MadCap:variable name=\"MissingVar\" /></p>"
    ].join("\n");

    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>([
        ["ProductName", "Flare Preview"],
        ["BuildVersion", "1.2.3"]
      ]),
      projectContext: undefined,
      currentDocument: vscode.Uri.file("/tmp/topic.htm")
    });

    assert.ok(result.html.includes("Flare Preview"));
    assert.ok(result.html.includes("1.2.3"));
    assert.ok(result.html.includes("madcap-missing-variable"));
    assert.ok(result.warnings.some((warning) => warning.includes("MissingVar")));
  });

  test("handles conditional blocks and dropdown conversion", async () => {
    const html = [
      "<MadCap:conditionalBlock condition=\"false\"><p>Hide me</p></MadCap:conditionalBlock>",
      "<MadCap:dropDown><MadCap:dropDownHotspot>Read More</MadCap:dropDownHotspot><p>Body</p></MadCap:dropDown>"
    ].join("\n");

    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>(),
      projectContext: undefined,
      currentDocument: vscode.Uri.file("/tmp/topic.htm")
    });

    assert.ok(!result.html.includes("Hide me"));
    assert.ok(result.html.includes("<details"));
    assert.ok(result.html.includes("Read More"));
    assert.ok(result.warnings.some((warning) => warning.includes("Conditional block hidden")));
  });

  test("loads snippets and marks unsupported tags", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flare-preview-test-"));
    const snippetPath = path.join(tempDir, "snippet.htm");
    await fs.writeFile(snippetPath, "<p>Snippet content</p>", "utf8");

    const html = [
      "<MadCap:snippet src=\"snippet.htm\" />",
      "<MadCap:breadcrumbs />"
    ].join("\n");

    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>(),
      projectContext: undefined,
      currentDocument: vscode.Uri.file(path.join(tempDir, "topic.htm"))
    });

    assert.ok(result.html.includes("Snippet content"));
    assert.ok(result.html.includes("Unsupported MadCap:breadcrumbs"));
    assert.ok(result.warnings.some((warning) => warning.includes("Unsupported MadCap tag")));
  });
});
