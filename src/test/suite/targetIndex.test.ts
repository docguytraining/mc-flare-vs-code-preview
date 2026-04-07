import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  PROJECT_DEFAULT_TARGET_ID,
  SHOW_EVERYTHING_TARGET_ID,
  discoverTargets
} from "../../flare/targetIndex";
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

suite("Target Index", () => {
  test("first entry is the synthetic Show Everything pseudo-target", async () => {
    const targets = await discoverTargets(fixtureContext());
    assert.ok(targets.length >= 2);
    assert.strictEqual(targets[0].id, SHOW_EVERYTHING_TARGET_ID);
    assert.strictEqual(targets[0].isShowEverything, true);
    assert.strictEqual(targets[0].expression, undefined);
  });

  test("second entry is the project default", async () => {
    const targets = await discoverTargets(fixtureContext());
    assert.strictEqual(targets[1].id, PROJECT_DEFAULT_TARGET_ID);
    assert.strictEqual(targets[1].isProjectDefault, true);
  });

  test("real .fltar files are discovered with their condition expression", async () => {
    const targets = await discoverTargets(fixtureContext());
    const publicWeb = targets.find((target) => target.displayName === "PublicWeb");
    assert.ok(publicWeb, "expected PublicWeb target from fixtures");
    assert.ok(publicWeb!.expression?.includes("Default.Public"));
    assert.ok(publicWeb!.expression?.includes("Default.Internal"));
    assert.strictEqual(publicWeb!.isShowEverything, false);
    assert.strictEqual(publicWeb!.isProjectDefault, false);
  });
});
