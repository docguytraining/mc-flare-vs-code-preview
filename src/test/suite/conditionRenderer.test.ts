import * as assert from "node:assert";
import { applyConditions } from "../../flare/conditionRenderer";
import { parseTargetExpression } from "../../flare/conditionExpression";

suite("Condition Renderer", () => {
  test("inventories element conditions without hiding when expression is empty", () => {
    const html = '<p MadCap:conditions="Default.Public">Hello</p>';
    const result = applyConditions(html);
    assert.ok(result.html.includes("Hello"));
    assert.ok(!result.html.includes("MadCap:conditions"));
    assert.strictEqual(result.elementConditionCounts.get("Default.Public"), 1);
    assert.strictEqual(result.hiddenCount, 0);
  });

  test("hides elements excluded by the active target", () => {
    const html =
      '<div MadCap:conditions="Default.Deprecated"><p>Old API</p></div><p>Current</p>';
    const expression = parseTargetExpression("exclude[Default.Deprecated]");
    const result = applyConditions(html, { expression });
    assert.ok(!result.html.includes("Old API"));
    assert.ok(result.html.includes("Current"));
    assert.strictEqual(result.hiddenCount, 1);
  });

  test("handles nested same-name elements when hiding", () => {
    const html =
      '<div MadCap:conditions="Default.Hidden"><div>inner</div><div>more</div></div><div>outer</div>';
    const expression = parseTargetExpression("exclude[Default.Hidden]");
    const result = applyConditions(html, { expression });
    assert.ok(!result.html.includes("inner"));
    assert.ok(!result.html.includes("more"));
    assert.ok(result.html.includes("outer"));
  });

  test("inserts a badge when showBadges is true", () => {
    const html = '<p MadCap:conditions="Default.Beta">Hi</p>';
    const result = applyConditions(html, { showBadges: true });
    assert.ok(result.html.includes("madcap-condition-badge"));
    assert.ok(result.html.includes("Default.Beta"));
  });

  test("inventories snippet condition expressions", () => {
    const html =
      '<MadCap:snippet src="x.flsnp" MadCap:conditionTagExpression="Default.Public" />';
    const result = applyConditions(html);
    assert.strictEqual(result.snippetConditionCounts.get("Default.Public"), 1);
  });

  test("comma-list element conditions count each tag once", () => {
    const html =
      '<p MadCap:conditions="Default.Public,Default.Beta">multi</p>';
    const result = applyConditions(html);
    assert.strictEqual(result.elementConditionCounts.get("Default.Public"), 1);
    assert.strictEqual(result.elementConditionCounts.get("Default.Beta"), 1);
  });

  test("comments and CDATA are passed through verbatim", () => {
    const html =
      '<!-- <p MadCap:conditions="X">comment</p> --><p>visible</p>';
    const result = applyConditions(html, {
      expression: parseTargetExpression("exclude[X]")
    });
    assert.ok(result.html.includes("<!--"));
    assert.ok(result.html.includes("comment"));
    assert.ok(result.html.includes("visible"));
    assert.strictEqual(result.hiddenCount, 0);
  });

  test("self-closing void elements with conditions are hidden cleanly", () => {
    const html = '<img MadCap:conditions="Default.Hidden" src="x.png" /><p>text</p>';
    const result = applyConditions(html, {
      expression: parseTargetExpression("exclude[Default.Hidden]")
    });
    assert.ok(!result.html.includes("x.png"));
    assert.ok(result.html.includes("text"));
    assert.strictEqual(result.hiddenCount, 1);
  });

  test("hiddenCount aggregates across multiple hidden siblings", () => {
    const html = [
      '<p MadCap:conditions="X">a</p>',
      '<p MadCap:conditions="X">b</p>',
      '<p>c</p>'
    ].join("");
    const result = applyConditions(html, {
      expression: parseTargetExpression("exclude[X]")
    });
    assert.strictEqual(result.hiddenCount, 2);
    assert.ok(!result.html.includes("a"));
    assert.ok(!result.html.includes("b"));
    assert.ok(result.html.includes("c"));
  });
});
