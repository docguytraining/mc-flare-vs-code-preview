import * as assert from "node:assert";
import {
  parseConditionsAttribute,
  parseTargetExpression,
  shouldRenderForTags
} from "../../flare/conditionExpression";

suite("Condition Expression Evaluator", () => {
  test("empty/undefined expression renders everything", () => {
    const expr = parseTargetExpression(undefined);
    assert.strictEqual(shouldRenderForTags(expr, []), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Deprecated"]), true);
  });

  test("include[A] renders only when A is on the element", () => {
    const expr = parseTargetExpression("include[Default.Public]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Internal"]), false);
    assert.strictEqual(shouldRenderForTags(expr, []), false);
  });

  test("exclude[A] hides only when A is on the element", () => {
    const expr = parseTargetExpression("exclude[Default.Deprecated]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Deprecated"]), false);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(shouldRenderForTags(expr, []), true);
  });

  test("AND between clauses", () => {
    const expr = parseTargetExpression("include[Default.Public] AND exclude[Default.Deprecated]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(
      shouldRenderForTags(expr, ["Default.Public", "Default.Deprecated"]),
      false
    );
    assert.strictEqual(shouldRenderForTags(expr, []), false);
  });

  test("OR inside include", () => {
    const expr = parseTargetExpression("include[Default.Public or Default.Beta]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Beta"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Internal"]), false);
  });

  test("nested grouping with parentheses", () => {
    const expr = parseTargetExpression("include[Default.Public or (Default.Beta and Default.Reviewed)]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Beta"]), false);
    assert.strictEqual(
      shouldRenderForTags(expr, ["Default.Beta", "Default.Reviewed"]),
      true
    );
  });

  test("malformed expression falls back to always-render", () => {
    const expr = parseTargetExpression("include[unclosed");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
  });

  test("parseConditionsAttribute splits comma list", () => {
    assert.deepStrictEqual(
      parseConditionsAttribute("Default.Public, Default.Beta"),
      ["Default.Public", "Default.Beta"]
    );
    assert.deepStrictEqual(parseConditionsAttribute(""), []);
    assert.deepStrictEqual(parseConditionsAttribute(undefined), []);
  });
});
