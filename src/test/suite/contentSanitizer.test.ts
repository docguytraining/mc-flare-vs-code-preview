import * as assert from "node:assert";
import { sanitizeCss, sanitizeHtml } from "../../security/contentSanitizer";

suite("Content Sanitizer", () => {
  test("strips script tags and reports removal", () => {
    const result = sanitizeHtml("<p>ok</p><script>alert(1)</script><p>after</p>");
    assert.ok(!result.html.includes("<script"));
    assert.ok(result.html.includes("<p>ok</p>"));
    assert.ok(result.html.includes("<p>after</p>"));
    assert.ok(result.removed.includes("script tag"));
  });

  test("removes inline event handlers", () => {
    const result = sanitizeHtml('<a href="#" onclick="alert(1)">click</a>');
    assert.ok(!/onclick/i.test(result.html));
    assert.ok(result.removed.includes("inline event handler"));
  });

  test("neutralizes javascript: URLs", () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/javascript:/i.test(result.html));
    assert.ok(result.removed.includes("javascript: URL"));
  });

  test("removes iframes, objects, meta refresh, and inline style blocks", () => {
    const html = [
      "<iframe src=\"https://evil.example\"></iframe>",
      "<object data=\"x\"></object>",
      "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\" />",
      "<style>body{background:url('https://evil.example/x.png')}</style>",
      "<p>safe</p>"
    ].join("");

    const result = sanitizeHtml(html);
    assert.ok(!result.html.includes("<iframe"));
    assert.ok(!result.html.includes("<object"));
    assert.ok(!/meta[^>]*refresh/i.test(result.html));
    assert.ok(!result.html.includes("<style"));
    assert.ok(result.html.includes("<p>safe</p>"));
  });

  test("leaves benign content untouched", () => {
    const html = "<article><h1>Hello</h1><p>World</p><img src=\"local.png\" alt=\"x\" /></article>";
    const result = sanitizeHtml(html);
    assert.strictEqual(result.html, html);
    assert.strictEqual(result.removed.length, 0);
  });

  test("sanitizeCss blocks external imports and url references", () => {
    const css = [
      "@import url('https://cdn.example/theme.css');",
      "body { background: url(\"http://cdn.example/bg.png\"); }",
      ".ok { color: red; }"
    ].join("\n");

    const result = sanitizeCss(css);
    assert.ok(!/@import/.test(result.css));
    assert.ok(!/https?:\/\//.test(result.css));
    assert.ok(result.css.includes(".ok { color: red; }"));
    assert.ok(result.removed >= 2);
  });
});
