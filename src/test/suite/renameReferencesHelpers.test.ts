import * as assert from "node:assert";
import * as path from "node:path";
import {
  isExternal,
  positionOf,
  resolveReferencePath,
  rewriteReferencePath,
  splitHash
} from "../../commands/renameReferencesHelpers";

suite("renameReferencesHelpers", () => {
  const projectRoot = path.normalize("/proj/Sample");

  test("resolveReferencePath treats leading slash as project-root-relative", () => {
    const resolved = resolveReferencePath(
      "/Content/Topics/Foo.htm",
      path.join(projectRoot, "Content", "Topics"),
      projectRoot
    );
    assert.strictEqual(resolved, path.normalize("/proj/Sample/Content/Topics/Foo.htm"));
  });

  test("resolveReferencePath resolves sibling-relative paths against the file dir", () => {
    const resolved = resolveReferencePath(
      "../Snippets/Hello.flsnp",
      path.join(projectRoot, "Content", "Topics"),
      projectRoot
    );
    assert.strictEqual(
      resolved,
      path.normalize("/proj/Sample/Content/Snippets/Hello.flsnp")
    );
  });

  test("resolveReferencePath returns undefined for empty input", () => {
    assert.strictEqual(
      resolveReferencePath("", path.join(projectRoot, "Content"), projectRoot),
      undefined
    );
  });

  test("rewriteReferencePath preserves project-root-relative style", () => {
    const fileDir = path.join(projectRoot, "Content", "Topics");
    const rewritten = rewriteReferencePath("/Content/Topics/Old.htm", fileDir, {
      oldPath: path.join(projectRoot, "Content", "Topics", "Old.htm"),
      newPath: path.join(projectRoot, "Content", "Topics", "New.htm")
    });
    assert.ok(rewritten.startsWith("/"), `expected leading slash, got ${rewritten}`);
    assert.ok(rewritten.endsWith("New.htm"));
  });

  test("rewriteReferencePath preserves sibling-relative style", () => {
    const fileDir = path.join(projectRoot, "Content", "Topics");
    const rewritten = rewriteReferencePath("../Snippets/Hello.flsnp", fileDir, {
      oldPath: path.join(projectRoot, "Content", "Snippets", "Hello.flsnp"),
      newPath: path.join(projectRoot, "Content", "Snippets", "Greeting.flsnp")
    });
    assert.ok(!rewritten.startsWith("/"));
    assert.ok(rewritten.endsWith("Greeting.flsnp"));
  });

  test("splitHash separates anchor from path", () => {
    assert.deepStrictEqual(splitHash("Foo.htm#section-2"), ["Foo.htm", "section-2"]);
    assert.deepStrictEqual(splitHash("Foo.htm"), ["Foo.htm", undefined]);
    assert.deepStrictEqual(splitHash("#anchor"), ["", "anchor"]);
  });

  test("isExternal recognizes URL schemes and protocol-relative", () => {
    assert.strictEqual(isExternal("https://example.com"), true);
    assert.strictEqual(isExternal("HTTP://example.com"), true);
    assert.strictEqual(isExternal("mailto:foo@bar"), true);
    assert.strictEqual(isExternal("//cdn.example.com/x.js"), true);
    assert.strictEqual(isExternal("../relative.htm"), false);
    assert.strictEqual(isExternal("/Content/foo.htm"), false);
  });

  test("positionOf returns 0/0 for offset 0", () => {
    assert.deepStrictEqual(positionOf("abc\ndef", 0), { line: 0, column: 0 });
  });

  test("positionOf counts lines and columns", () => {
    const text = "first\nsecond\nthird";
    const offset = text.indexOf("third");
    assert.deepStrictEqual(positionOf(text, offset), { line: 2, column: 0 });
  });

  test("positionOf handles offsets past the last newline", () => {
    const text = "alpha\nbravo";
    assert.deepStrictEqual(positionOf(text, text.length), { line: 1, column: 5 });
  });
});
