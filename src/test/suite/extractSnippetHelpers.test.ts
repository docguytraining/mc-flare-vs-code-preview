import * as assert from "node:assert";
import * as path from "node:path";
import {
  buildSnippetFileContent,
  computeSnippetSrcAttribute,
  rewriteLocalReferences,
  rewriteOneReferenceValue,
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

  // Issue 5 — when a selection containing nested references is lifted into
  // a new snippet file, every local path attribute (`href`, `src`,
  // `source`, `xlink:href`, `MadCap:Link`, `Link`, `File`, `Topic`) must
  // be re-anchored from the source topic's directory to the new snippet
  // file's directory. The bug originally surfaced for nested
  // <MadCap:snippet> refs, but the same shape applies to images and
  // <MadCap:xref> tags too — those are covered here so a future regression
  // is caught.
  suite("rewriteLocalReferences", () => {
    const fromTopic = path.normalize("/proj/Sample/Content/Topics/Install/install.htm");
    const toSnippet = path.normalize(
      "/proj/Sample/Content/Resources/Snippets/Install/intro.flsnp"
    );

    test("rewrites a nested snippet src to be relative to the new snippet file", () => {
      // The source topic uses `../../Resources/Snippets/warning.flsnp` to
      // reach a sibling snippet. From the new snippet file (which lives
      // under Resources/Snippets/Install/) the same target is `../warning.flsnp`.
      const input =
        '<p>Heads up: <MadCap:snippet src="../../Resources/Snippets/warning.flsnp" /></p>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(out, /src="\.\.\/warning\.flsnp"/);
    });

    test("rewrites a nested image src", () => {
      // Topic referenced `../../Resources/Images/diagram.png`. From the
      // new snippet location, the path is `../../Images/diagram.png`.
      const input = '<p><img src="../../Resources/Images/diagram.png" alt="diagram" /></p>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(out, /src="\.\.\/\.\.\/Images\/diagram\.png"/);
    });

    test("rewrites a nested MadCap:xref href", () => {
      // The original href `../Reference/Api.htm` resolves to the
      // Reference/Api.htm sibling of Topics/Install/. From the new
      // snippet location, the same target is at
      // `../../../Topics/Reference/Api.htm`.
      const input = '<p>See <MadCap:xref href="../Reference/Api.htm">API</MadCap:xref></p>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(out, /href="\.\.\/\.\.\/\.\.\/Topics\/Reference\/Api\.htm"/);
    });

    test("rewrites a nested anchor href", () => {
      // Plain HTML <a href> needs the same treatment as <MadCap:xref>.
      const input = '<p><a href="sibling.htm">link</a></p>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(out, /href="\.\.\/\.\.\/\.\.\/Topics\/Install\/sibling\.htm"/);
    });

    test("preserves a #fragment suffix on a rewritten href", () => {
      const input = '<MadCap:xref href="../Reference/Api.htm#configure">Configure</MadCap:xref>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(
        out,
        /href="\.\.\/\.\.\/\.\.\/Topics\/Reference\/Api\.htm#configure"/
      );
    });

    test("leaves project-root-relative refs untouched", () => {
      // `/`-prefixed Flare paths are project-root-relative, so they're
      // already independent of where the file containing them lives.
      const input = '<a href="/Content/Topics/Other.htm">link</a>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.strictEqual(out, input);
    });

    test("leaves external URLs untouched", () => {
      const input =
        '<a href="https://example.com">site</a><a href="mailto:hi@example.com">mail</a>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.strictEqual(out, input);
    });

    test("leaves bare anchor refs untouched", () => {
      const input = '<a href="#bookmark">jump</a>';
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.strictEqual(out, input);
    });

    test("returns the input unchanged when source and destination directories match", () => {
      const sameDirSnippet = path.normalize("/proj/Sample/Content/Topics/Install/lifted.flsnp");
      const input = '<p><img src="diagram.png" /></p>';
      const out = rewriteLocalReferences(input, fromTopic, sameDirSnippet);
      assert.strictEqual(out, input);
    });

    test("rewrites multiple references in a single pass", () => {
      const input = [
        "<div>",
        '  <img src="../../Resources/Images/a.png" />',
        '  <MadCap:snippet src="../../Resources/Snippets/b.flsnp" />',
        '  <MadCap:xref href="../Reference/c.htm">c</MadCap:xref>',
        "</div>"
      ].join("\n");
      const out = rewriteLocalReferences(input, fromTopic, toSnippet);
      assert.match(out, /src="\.\.\/\.\.\/Images\/a\.png"/);
      assert.match(out, /src="\.\.\/b\.flsnp"/);
      assert.match(out, /href="\.\.\/\.\.\/\.\.\/Topics\/Reference\/c\.htm"/);
    });

    test("rewriteOneReferenceValue is a no-op for empty / external / anchor / project-root values", () => {
      const fromDir = path.normalize("/proj/a");
      const toDir = path.normalize("/proj/b");
      assert.strictEqual(rewriteOneReferenceValue("", fromDir, toDir), "");
      assert.strictEqual(rewriteOneReferenceValue("https://x", fromDir, toDir), "https://x");
      assert.strictEqual(rewriteOneReferenceValue("//cdn", fromDir, toDir), "//cdn");
      assert.strictEqual(rewriteOneReferenceValue("#bm", fromDir, toDir), "#bm");
      assert.strictEqual(rewriteOneReferenceValue("/Content/x.htm", fromDir, toDir), "/Content/x.htm");
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
