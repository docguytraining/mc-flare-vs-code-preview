import * as assert from "node:assert";
import { svgGutterDataUri } from "../../diagnostics/conditionGutterDecorations";

suite("Condition Gutter — SVG generator", () => {
  test("emits a data: URI for a known hex color", () => {
    const uri = svgGutterDataUri("#ff8800");
    assert.ok(uri.startsWith("data:image/svg+xml"));
    const decoded = decodeURIComponent(uri.split(",")[1]);
    assert.ok(decoded.includes('fill="#ff8800"'));
    assert.ok(decoded.includes("<svg"));
    assert.ok(decoded.includes("</svg>"));
  });

  test("falls back to neutral grey for unsupported color formats", () => {
    const uri = svgGutterDataUri("not-a-color");
    const decoded = decodeURIComponent(uri.split(",")[1]);
    assert.ok(decoded.includes('fill="#888888"'));
  });

  test("strips alpha from #rrggbbaa hex", () => {
    const uri = svgGutterDataUri("#11223344");
    const decoded = decodeURIComponent(uri.split(",")[1]);
    assert.ok(decoded.includes('fill="#112233"'));
  });

  test("accepts shorthand #rgb", () => {
    const uri = svgGutterDataUri("#abc");
    const decoded = decodeURIComponent(uri.split(",")[1]);
    assert.ok(decoded.includes('fill="#abc"'));
  });
});
