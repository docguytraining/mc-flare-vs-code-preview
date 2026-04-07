import * as assert from "node:assert";
import { isAttributeArea } from "../../language/conditionAttributeCompletionProvider";

suite("conditionAttributeCompletionProvider — isAttributeArea", () => {
  test("returns true inside an opening tag past the tag name", () => {
    assert.strictEqual(isAttributeArea("<p "), true);
    assert.strictEqual(isAttributeArea("<MadCap:dropDown "), true);
    assert.strictEqual(isAttributeArea("<p class=\"foo\" "), true);
  });

  test("returns false before the tag name has whitespace after it", () => {
    assert.strictEqual(isAttributeArea("<p"), false);
    assert.strictEqual(isAttributeArea("<MadCap:dropDow"), false);
  });

  test("returns false in plain text content", () => {
    assert.strictEqual(isAttributeArea("Just some prose"), false);
  });

  test("returns false after the tag has been closed", () => {
    assert.strictEqual(isAttributeArea("<p>hello"), false);
  });

  test("returns false inside an existing attribute value (odd quote count)", () => {
    assert.strictEqual(isAttributeArea('<p class="foo'), false);
    assert.strictEqual(isAttributeArea("<p class='foo"), false);
  });

  test("returns false for a closing tag", () => {
    assert.strictEqual(isAttributeArea("</p"), false);
  });
});
