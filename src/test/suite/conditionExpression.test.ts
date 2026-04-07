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

  test("parseConditionsAttribute also accepts semicolon-delimited lists", () => {
    assert.deepStrictEqual(
      parseConditionsAttribute("Default.Public; Default.Beta"),
      ["Default.Public", "Default.Beta"]
    );
  });

  test("parseConditionsAttribute drops empty entries from trailing commas", () => {
    assert.deepStrictEqual(
      parseConditionsAttribute("Default.Public,,Default.Beta,"),
      ["Default.Public", "Default.Beta"]
    );
  });

  test("not prefix inverts the inner predicate", () => {
    const expr = parseTargetExpression("include[not Default.Internal]");
    assert.strictEqual(shouldRenderForTags(expr, []), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Internal"]), false);
  });

  test("multiple top-level AND clauses are all required", () => {
    const expr = parseTargetExpression(
      "include[Default.Public] AND exclude[Default.Internal] AND exclude[Default.Beta]"
    );
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Public"]), true);
    assert.strictEqual(
      shouldRenderForTags(expr, ["Default.Public", "Default.Beta"]),
      false
    );
    assert.strictEqual(
      shouldRenderForTags(expr, ["Default.Public", "Default.Internal"]),
      false
    );
  });

  test("OR has lower precedence than AND", () => {
    // include[A and B or C] should mean (A and B) or C, so just C is enough.
    const expr = parseTargetExpression("include[Default.A and Default.B or Default.C]");
    assert.strictEqual(shouldRenderForTags(expr, ["Default.C"]), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.A"]), false);
    assert.strictEqual(
      shouldRenderForTags(expr, ["Default.A", "Default.B"]),
      true
    );
  });

  test("whitespace-only input renders everything", () => {
    const expr = parseTargetExpression("   ");
    assert.strictEqual(shouldRenderForTags(expr, []), true);
    assert.strictEqual(shouldRenderForTags(expr, ["Default.Anything"]), true);
  });
});
