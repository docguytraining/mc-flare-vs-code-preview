import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { transformMadcapContent } from "../../flare/madcapTransformPipeline";

suite("MadCap Transform Pipeline", () => {
  test("resolves <MadCap:variable> references and marks unresolved ones", async () => {
    const html = [
      "<p><MadCap:variable name=\"ProductName\" /></p>",
      "<p><MadCap:variable name=\"MissingVar\" /></p>"
    ].join("\n");

    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>([
        ["ProductName", "Flare Preview"]
      ]),
      projectContext: undefined,
      currentDocument: vscode.Uri.file("/tmp/topic.htm")
    });

    assert.ok(result.html.includes("Flare Preview"));
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

  test("renders dropDown / dropDownHead / dropDownHotspot / dropDownBody inside a snippet body (regression)", async () => {
    // The dropDown handler used to run *before* the snippet handler, which
    // meant any dropDown markup that lived inside a `.flsnp` body never got
    // transformed and fell through to the unsupported-tag fallback. The
    // pipeline now runs snippets first so the loaded body is visible to the
    // dropDown pass that runs immediately after.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flare-dropdown-snippet-"));
    const snippetPath = path.join(tempDir, "with-dropdown.flsnp");
    await fs.writeFile(
      snippetPath,
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<html><body>",
        "  <MadCap:dropDown>",
        "    <MadCap:dropDownHead>",
        "      <MadCap:dropDownHotspot>Click to expand</MadCap:dropDownHotspot>",
        "    </MadCap:dropDownHead>",
        "    <MadCap:dropDownBody>",
        "      <p>Hidden body content from inside the snippet.</p>",
        "    </MadCap:dropDownBody>",
        "  </MadCap:dropDown>",
        "</body></html>"
      ].join("\n"),
      "utf8"
    );

    const html = '<MadCap:snippetBlock src="with-dropdown.flsnp" />';
    const result = await transformMadcapContent(html, {
      variables: new Map<string, string>(),
      projectContext: undefined,
      currentDocument: vscode.Uri.file(path.join(tempDir, "topic.htm"))
    });

    assert.ok(
      result.html.includes("<details"),
      "expected the dropDown inside the snippet to render as <details>"
    );
    assert.ok(
      result.html.includes("Click to expand"),
      "expected the hotspot to become the <summary>"
    );
    assert.ok(
      result.html.includes("Hidden body content from inside the snippet."),
      "expected the dropDownBody content to survive"
    );
    // None of the structural dropDown wrappers should leak through as
    // unsupported tags.
    assert.ok(
      !result.html.includes("Unsupported MadCap:dropDown"),
      "dropDown should not be marked unsupported"
    );
    assert.ok(
      !result.html.includes("Unsupported MadCap:dropDownHead"),
      "dropDownHead should not be marked unsupported"
    );
    assert.ok(
      !result.html.includes("Unsupported MadCap:dropDownHotspot"),
      "dropDownHotspot should not be marked unsupported"
    );
    assert.ok(
      !result.html.includes("Unsupported MadCap:dropDownBody"),
      "dropDownBody should not be marked unsupported"
    );
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
