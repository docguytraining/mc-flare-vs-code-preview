import * as assert from "node:assert";
import { transformFlareCss } from "../../flare/flareCssTransform";

suite("flareCssTransform", () => {
  test("converts a simple bold autonum into a :before companion rule", () => {
    const css = "div.Note p.Head { mc-auto-number-format: \"{b}NOTE  {/b}\"; }";
    const result = transformFlareCss(css);
    assert.strictEqual(result.generatedRuleCount, 1);
    assert.ok(result.css.includes("div.Note p.Head:before"));
    assert.ok(result.css.includes("content: \"NOTE  \""));
    assert.ok(result.css.includes("font-weight: bold"));
    assert.ok(!result.css.includes("mc-auto-number-format"));
  });

  test("preserves other declarations in the original rule", () => {
    const css = "div.Tip p.Head { color: blue; mc-auto-number-format: \"{b}TIP  {/b}\"; padding: 4px; }";
    const result = transformFlareCss(css);
    assert.ok(result.css.includes("color: blue"));
    assert.ok(result.css.includes("padding: 4px"));
    assert.ok(result.css.includes("div.Tip p.Head:before"));
    assert.ok(!result.css.includes("mc-auto-number-format"));
  });

  test("strips group prefixes and counter tokens", () => {
    const css = "h1 { mc-auto-number-format: \"GH:Chapter {Gn+}: \"; }";
    const result = transformFlareCss(css);
    assert.ok(result.css.includes("content: \"Chapter : \""));
    assert.ok(!result.css.includes("GH:"));
    assert.ok(!result.css.includes("{Gn+}"));
  });

  test("strips font/color wrappers but keeps inner content", () => {
    const css = "p.Custom { mc-auto-number-format: \"{color:red}{b}Under Construction!{/b} Please check back later.{/color}\"; }";
    const result = transformFlareCss(css);
    assert.ok(result.css.includes("Under Construction!"));
    assert.ok(result.css.includes("Please check back later"));
    assert.ok(!result.css.includes("{color"));
    assert.ok(!result.css.includes("{b}"));
  });

  test("appends :before to each branch of a comma-separated selector", () => {
    const css = "p.Figure_Title, p.Figure_wide_Title { mc-auto-number-format: \"{b}Figure: {/b}\"; }";
    const result = transformFlareCss(css);
    assert.ok(result.css.includes("p.Figure_Title:before"));
    assert.ok(result.css.includes("p.Figure_wide_Title:before"));
  });

  test("decodes &#160; into a non-breaking space", () => {
    const css = "div.Important p.Head { mc-auto-number-format: \"{b}IMPORTANT &#160;{/b}\"; }";
    const result = transformFlareCss(css);
    assert.ok(result.css.includes("IMPORTANT \u00a0"));
  });

  test("leaves CSS without autonum properties untouched", () => {
    const css = "body { color: black; }\np { margin: 0; }";
    const result = transformFlareCss(css);
    assert.strictEqual(result.generatedRuleCount, 0);
    assert.strictEqual(result.css, css);
  });
});
