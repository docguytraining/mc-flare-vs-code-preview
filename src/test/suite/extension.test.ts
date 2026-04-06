import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  test("Preview command executes for HTML document", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "html",
      content: "<html><body><p>Test</p></body></html>"
    });

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("flare.previewHtml");

    assert.ok(true);
  });
});
