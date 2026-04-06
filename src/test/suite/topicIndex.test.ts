import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { TopicIndex, extractBookmarks, extractH1 } from "../../flare/topicIndex";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");

suite("TopicIndex", () => {
  test("extractH1 returns the first heading text and strips tags", () => {
    assert.strictEqual(extractH1("<h1>Hello <em>World</em></h1>"), "Hello World");
    assert.strictEqual(extractH1("<html><body><p>no heading</p></body></html>"), undefined);
  });

  test("extractBookmarks finds id, name, and MadCap:anchor", () => {
    const html = [
      "<h2 id=\"install\">Install</h2>",
      "<a name=\"legacy\"></a>",
      "<MadCap:anchor name=\"milestone\" />",
      "<p id=\"install\">duplicate ignored</p>"
    ].join("\n");
    const bookmarks = extractBookmarks(html);
    const ids = bookmarks.map((entry) => entry.id);
    assert.deepStrictEqual(ids.sort(), ["install", "legacy", "milestone"]);
  });

  test("getEntries walks the fixture project and records H1/bookmarks", async () => {
    const topicIndex = new TopicIndex();
    const projectRoot = vscode.Uri.file(FIXTURE_ROOT);
    const context = {
      projectFile: vscode.Uri.file(path.join(FIXTURE_ROOT, "Sample.flprj")),
      projectRoot,
      variableFiles: [],
      referencedStylesheets: []
    };
    const entries = await topicIndex.getEntries(context);
    const installation = entries.find((entry) => entry.relPath.endsWith("Installation.htm"));
    assert.ok(installation, "expected Installation.htm in the index");
    assert.strictEqual(installation!.h1, "Install Flare Preview");
    const bookmarkIds = installation!.bookmarks.map((bookmark) => bookmark.id).sort();
    assert.deepStrictEqual(bookmarkIds, ["prerequisites", "steps"]);

    const overview = entries.find((entry) => entry.relPath.endsWith("Overview.htm"));
    assert.ok(overview, "expected Overview.htm in the index");
  });

  test("invalidateForPath clears cached entries under the affected root", async () => {
    const topicIndex = new TopicIndex();
    const context = {
      projectFile: vscode.Uri.file(path.join(FIXTURE_ROOT, "Sample.flprj")),
      projectRoot: vscode.Uri.file(FIXTURE_ROOT),
      variableFiles: [],
      referencedStylesheets: []
    };
    const first = await topicIndex.getEntries(context);
    topicIndex.invalidateForPath(path.join(FIXTURE_ROOT, "Content", "Topics", "Installation.htm"));
    const second = await topicIndex.getEntries(context);
    assert.notStrictEqual(first, second, "expected a fresh scan after invalidation");
    assert.strictEqual(first.length, second.length);
  });
});
