import * as assert from "node:assert";
import * as path from "node:path";
import {
  buildSnippetFileContent,
  computeSnippetSrcAttribute,
  slugifySnippetName,
  stripCommonIndent
} from "../../commands/extractSnippetHelpers";

suite("extractSnippetHelpers", () => {
  suite("slugifySnippetName", () => {
    test("accepts a clean kebab-case name", () => {
      const result = slugifySnippetName("install-prereqs");
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.slug, "install-prereqs");
    });

    test("normalizes whitespace into dashes", () => {
      const result = slugifySnippetName("  installation prereqs  ");
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.slug, "installation-prereqs");
    });

    test("strips disallowed characters and collapses dashes", () => {
      const result = slugifySnippetName("foo!!  bar??--baz");
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.slug, "foo-bar-baz");
    });

    test("rejects an empty input", () => {
      const result = slugifySnippetName("   ");
      assert.strictEqual(result.ok, false);
      assert.match(result.reason ?? "", /empty/i);
    });

    test("rejects an input that contains no usable characters", () => {
      const result = slugifySnippetName("???");
      assert.strictEqual(result.ok, false);
    });

    test("rejects reserved Windows filenames", () => {
      const result = slugifySnippetName("con");
      assert.strictEqual(result.ok, false);
      assert.match(result.reason ?? "", /reserved/i);
    });
  });

  suite("buildSnippetFileContent", () => {
    test("wraps the inner XHTML in the canonical .flsnp skeleton", () => {
      const out = buildSnippetFileContent("<p>Hello world</p>");
      assert.match(out, /<\?xml version="1\.0" encoding="utf-8"\?>/);
      assert.match(out, /xmlns:MadCap="http:\/\/www\.madcapsoftware\.com\/Schemas\/MadCap\.xsd"/);
      assert.match(out, /<head><\/head>/);
      assert.match(out, /<body>[\s\S]*<p>Hello world<\/p>[\s\S]*<\/body>/);
    });

    test("indents the body content under <body>", () => {
      const out = buildSnippetFileContent("<p>One</p>\n<p>Two</p>");
      assert.match(out, /^ {4}<p>One<\/p>$/m);
      assert.match(out, /^ {4}<p>Two<\/p>$/m);
    });
  });

  suite("computeSnippetSrcAttribute", () => {
    test("returns a sibling-relative path with forward slashes", () => {
      const fromTopic = path.normalize("/proj/Sample/Content/Topics/Intro.htm");
      const toSnippet = path.normalize(
        "/proj/Sample/Content/Resources/Snippets/Install/prereqs.flsnp"
      );
      assert.strictEqual(
        computeSnippetSrcAttribute(fromTopic, toSnippet),
        "../Resources/Snippets/Install/prereqs.flsnp"
      );
    });

    test("returns the basename when the file is in the same directory", () => {
      const fromTopic = path.normalize("/proj/Sample/Content/Topics/Intro.htm");
      const toSnippet = path.normalize("/proj/Sample/Content/Topics/sibling.flsnp");
      assert.strictEqual(
        computeSnippetSrcAttribute(fromTopic, toSnippet),
        "sibling.flsnp"
      );
    });
  });

  suite("stripCommonIndent", () => {
    test("strips the longest common leading-whitespace prefix", () => {
      const input = ["    <p>One</p>", "    <p>Two</p>", "    <p>Three</p>"].join("\n");
      assert.strictEqual(
        stripCommonIndent(input),
        ["<p>One</p>", "<p>Two</p>", "<p>Three</p>"].join("\n")
      );
    });

    test("ignores blank lines when computing the common indent", () => {
      const input = ["  <p>One</p>", "", "  <p>Two</p>"].join("\n");
      assert.strictEqual(
        stripCommonIndent(input),
        ["<p>One</p>", "", "<p>Two</p>"].join("\n")
      );
    });

    test("returns the input unchanged when no common indent exists", () => {
      const input = "<p>One</p>\n  <p>Two</p>";
      assert.strictEqual(stripCommonIndent(input), input);
    });

    test("handles a single line", () => {
      assert.strictEqual(stripCommonIndent("    <p>One</p>"), "<p>One</p>");
    });
  });
});
