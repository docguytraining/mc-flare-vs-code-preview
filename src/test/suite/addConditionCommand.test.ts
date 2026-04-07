import * as assert from "node:assert";
import {
  parseConditionList,
  rewriteTagWithConditions
} from "../../commands/addConditionCommand";

suite("addConditionCommand helpers", () => {
  test("parseConditionList splits comma- and semicolon-delimited values", () => {
    assert.deepStrictEqual(
      parseConditionList("Default.Public, Default.Internal;Audience.Pro"),
      ["Default.Public", "Default.Internal", "Audience.Pro"]
    );
  });

  test("parseConditionList drops empty entries and trims whitespace", () => {
    assert.deepStrictEqual(
      parseConditionList(" Default.Public , , ;  "),
      ["Default.Public"]
    );
  });

  test("parseConditionList returns an empty array for the empty string", () => {
    assert.deepStrictEqual(parseConditionList(""), []);
  });

  test("rewriteTagWithConditions inserts the attribute on a tag without one", () => {
    const result = rewriteTagWithConditions(
      "<p class='intro'>",
      "Default.Public"
    );
    assert.strictEqual(result, '<p MadCap:conditions="Default.Public" class=\'intro\'>');
  });

  test("rewriteTagWithConditions replaces an existing attribute value in place", () => {
    const result = rewriteTagWithConditions(
      '<p MadCap:conditions="Default.Internal" class="intro">',
      "Default.Public,Default.Internal"
    );
    assert.strictEqual(
      result,
      '<p MadCap:conditions="Default.Public,Default.Internal" class="intro">'
    );
  });

  test("rewriteTagWithConditions preserves namespaced and self-closing tags", () => {
    const result = rewriteTagWithConditions(
      "<MadCap:dropDown class='foo'/>",
      "Default.Public"
    );
    assert.strictEqual(
      result,
      "<MadCap:dropDown MadCap:conditions=\"Default.Public\" class='foo'/>"
    );
  });

  test("parseConditionList accepts a semicolon-only list", () => {
    assert.deepStrictEqual(
      parseConditionList("Default.Public;Default.Internal"),
      ["Default.Public", "Default.Internal"]
    );
  });

  test("rewriteTagWithConditions can encode a comma-joined list onto a fresh tag", () => {
    const result = rewriteTagWithConditions(
      "<p>",
      "Default.Public,Default.Internal"
    );
    assert.strictEqual(
      result,
      '<p MadCap:conditions="Default.Public,Default.Internal">'
    );
  });

  test("rewriteTagWithConditions overwrites a single-quoted attribute value", () => {
    const result = rewriteTagWithConditions(
      "<p MadCap:conditions='Default.Internal'>",
      "Default.Public"
    );
    assert.strictEqual(result, '<p MadCap:conditions="Default.Public">');
  });
});
