import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { SnippetIndex, extractSnippetPreview } from "../../flare/snippetIndex";
import { FlareProjectContext } from "../../core/types";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-snippet-index-"));
  await fs.mkdir(path.join(root, "Content", "Resources", "Snippets", "Install"), {
    recursive: true
  });
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Resources", "Snippets", "intro.flsnp"),
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">\n  <body>\n    <p>Welcome to the toolkit.</p>\n  </body>\n</html>\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Resources", "Snippets", "Install", "prereqs.flsnp"),
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">\n  <body>\n    <p>Install prerequisites first.</p>\n  </body>\n</html>\n',
    "utf8"
  );
  return root;
}

function makeContext(root: string): FlareProjectContext {
  return {
    projectFile: vscode.Uri.file(path.join(root, "Sample.flprj")),
    projectRoot: vscode.Uri.file(root),
    variableFiles: [],
    referencedStylesheets: []
  };
}

suite("SnippetIndex", () => {
  test("discovers .flsnp files under Content/Resources/Snippets and subfolders", async () => {
    const root = await makeProject();
    const index = new SnippetIndex();
    const entries = await index.getEntries(makeContext(root));
    const names = entries.map((entry) => entry.name).sort();
    assert.deepStrictEqual(names, ["intro", "prereqs"]);
  });

  test("captures folder relative path and snippet preview text", async () => {
    const root = await makeProject();
    const index = new SnippetIndex();
    const entries = await index.getEntries(makeContext(root));
    const prereqs = entries.find((entry) => entry.name === "prereqs")!;
    assert.strictEqual(prereqs.folder, "Install");
    assert.strictEqual(prereqs.preview, "Install prerequisites first.");
    const intro = entries.find((entry) => entry.name === "intro")!;
    assert.strictEqual(intro.folder, "");
    assert.strictEqual(intro.preview, "Welcome to the toolkit.");
  });

  test("returns the cached entries on a second call", async () => {
    const root = await makeProject();
    const index = new SnippetIndex();
    const a = await index.getEntries(makeContext(root));
    const b = await index.getEntries(makeContext(root));
    assert.strictEqual(a, b);
  });

  test("invalidateForPath drops the cache for the matching project", async () => {
    const root = await makeProject();
    const index = new SnippetIndex();
    const a = await index.getEntries(makeContext(root));
    index.invalidateForPath(path.join(root, "Content", "Resources", "Snippets", "intro.flsnp"));
    const b = await index.getEntries(makeContext(root));
    assert.notStrictEqual(a, b);
    assert.deepStrictEqual(
      a.map((entry) => entry.name).sort(),
      b.map((entry) => entry.name).sort()
    );
  });
});

suite("extractSnippetPreview", () => {
  test("returns the first body text content", () => {
    const xml = "<html><body><p>Hello world</p></body></html>";
    assert.strictEqual(extractSnippetPreview(xml), "Hello world");
  });

  test("collapses whitespace and strips inline markup", () => {
    const xml = "<html><body>  <p>Hello   <strong>world</strong>!</p>  </body></html>";
    assert.strictEqual(extractSnippetPreview(xml), "Hello world !");
  });

  test("truncates long previews", () => {
    const long = "x".repeat(200);
    const xml = `<html><body><p>${long}</p></body></html>`;
    const preview = extractSnippetPreview(xml);
    assert.ok(preview);
    assert.ok(preview!.length <= 80);
    assert.ok(preview!.endsWith("…"));
  });

  test("returns undefined for an empty body", () => {
    assert.strictEqual(extractSnippetPreview("<html><body>   </body></html>"), undefined);
  });

  test("ignores XML/HTML comments", () => {
    const xml = "<html><body><!-- author note --><p>Visible</p></body></html>";
    assert.strictEqual(extractSnippetPreview(xml), "Visible");
  });
});
