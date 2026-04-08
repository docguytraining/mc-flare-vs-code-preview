import * as assert from "node:assert";
import * as vscode from "vscode";
import { findEnclosingOpeningTag } from "../../language/addConditionCodeActionProvider";

async function openHtmlDoc(content: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ language: "html", content });
}

suite("findEnclosingOpeningTag", () => {
  test("returns the opening tag and no existing conditions for a plain element", async () => {
    const doc = await openHtmlDoc('<p class="intro">Hello world</p>');
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 20));
    assert.ok(result);
    assert.strictEqual(doc.getText(result!.tagRange), '<p class="intro">');
    assert.strictEqual(result!.existingConditions, undefined);
  });

  test("extracts an existing MadCap:conditions value", async () => {
    const doc = await openHtmlDoc(
      '<p MadCap:conditions="Default.Public">Hello</p>'
    );
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 40));
    assert.ok(result);
    assert.strictEqual(result!.existingConditions, "Default.Public");
  });

  test("returns undefined when the cursor is in plain text outside any tag", async () => {
    const doc = await openHtmlDoc("Just some prose without markup.");
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 5));
    assert.strictEqual(result, undefined);
  });

  test("returns undefined for a closing tag", async () => {
    const doc = await openHtmlDoc("<p>Hello</p>");
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 9));
    assert.strictEqual(result, undefined);
  });

  test("returns undefined for an HTML comment", async () => {
    const doc = await openHtmlDoc("<!-- not a tag -->");
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 6));
    assert.strictEqual(result, undefined);
  });

  test("returns the deepest enclosing element when cursor sits in nested text", async () => {
    const doc = await openHtmlDoc("<div><p>Hello <strong>world</strong></p></div>");
    // Cursor inside "world" — innermost element is <strong>.
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 24));
    assert.ok(result);
    assert.strictEqual(doc.getText(result!.tagRange), "<strong>");
    assert.strictEqual(result!.existingConditions, undefined);
  });

  test("returns the parent element after a self-closing void child", async () => {
    const doc = await openHtmlDoc('<p>line<br />after</p>');
    // Cursor inside "after" — <br /> is self-closing so the enclosing element is still <p>.
    const result = createPosition(doc, 14);
    const found = findEnclosingOpeningTag(doc, result);
    assert.ok(found);
    assert.strictEqual(doc.getText(found!.tagRange), "<p>");
  });

  test("ignores siblings that have already closed", async () => {
    const doc = await openHtmlDoc("<div><span>x</span><p>cursor</p></div>");
    // Cursor inside "cursor" — <span> already closed, enclosing element is <p>.
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 24));
    assert.ok(result);
    assert.strictEqual(doc.getText(result!.tagRange), "<p>");
  });

  test("returns the enclosing element when cursor is in text and the tag has existing conditions", async () => {
    const doc = await openHtmlDoc(
      '<p MadCap:conditions="Default.Public">Hello world</p>'
    );
    const result = findEnclosingOpeningTag(doc, new vscode.Position(0, 45));
    assert.ok(result);
    assert.strictEqual(result!.existingConditions, "Default.Public");
  });
});

function createPosition(doc: vscode.TextDocument, offset: number): vscode.Position {
  return doc.positionAt(offset);
}
