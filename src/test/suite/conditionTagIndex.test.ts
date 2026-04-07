import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConditionTagIndex } from "../../flare/conditionTagIndex";
import { FlareProjectContext } from "../../core/types";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");

function fixtureContext(): FlareProjectContext {
  const root = vscode.Uri.file(FIXTURE_ROOT);
  return {
    projectFile: vscode.Uri.file(path.join(FIXTURE_ROOT, "Sample.flprj")),
    projectRoot: root,
    variableFiles: [],
    referencedStylesheets: []
  };
}

suite("ConditionTagIndex", () => {
  test("discovers every .flcts file under Project/ConditionTagSets", async () => {
    const index = new ConditionTagIndex();
    const tags = await index.getEntries(fixtureContext());
    const names = tags.map((tag) => tag.qualifiedName).sort();
    assert.ok(names.includes("Default.Public"));
    assert.ok(names.includes("Default.Internal"));
    assert.ok(names.includes("Default.Beta"));
    assert.ok(names.includes("Audience.Admin"));
    assert.ok(names.includes("Audience.EndUser"));
  });

  test("captures color and comment metadata", async () => {
    const index = new ConditionTagIndex();
    const found = await index.lookup(fixtureContext(), "Default.Public");
    assert.ok(found);
    assert.strictEqual(found!.color, "#4caf50");
    assert.ok(found!.description?.includes("public-facing"));
  });

  test("returns undefined for unknown tag and false for hasTag", async () => {
    const index = new ConditionTagIndex();
    const ctx = fixtureContext();
    assert.strictEqual(await index.lookup(ctx, "Default.DoesNotExist"), undefined);
    assert.strictEqual(await index.hasTag(ctx, "Default.DoesNotExist"), false);
    assert.strictEqual(await index.hasTag(ctx, "Default.Public"), true);
  });

  test("set name comes from the .flcts filename, not file content", async () => {
    const index = new ConditionTagIndex();
    const all = await index.getEntries(fixtureContext());
    const sets = new Set(all.map((tag) => tag.setName));
    assert.ok(sets.has("Default"));
    assert.ok(sets.has("Audience"));
  });

  test("invalidateForPath drops the cache for an affected project", async () => {
    const index = new ConditionTagIndex();
    const ctx = fixtureContext();
    const first = await index.getEntries(ctx);
    assert.ok(first.length > 0);
    index.invalidateForPath(path.join(FIXTURE_ROOT, "Project", "ConditionTagSets", "Default.flcts"));
    // Re-fetching should still succeed and return the same data.
    const second = await index.getEntries(ctx);
    assert.deepStrictEqual(
      second.map((tag) => tag.qualifiedName).sort(),
      first.map((tag) => tag.qualifiedName).sort()
    );
  });

  test("invalidateForPath ignores non-flcts files", async () => {
    const index = new ConditionTagIndex();
    const ctx = fixtureContext();
    await index.getEntries(ctx);
    // Should be a no-op — won't throw, won't drop the cache.
    index.invalidateForPath(path.join(FIXTURE_ROOT, "Sample.flprj"));
    const after = await index.getEntries(ctx);
    assert.ok(after.length > 0);
  });
});
