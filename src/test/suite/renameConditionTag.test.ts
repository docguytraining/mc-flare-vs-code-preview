import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanProjectForOccurrences } from "../../commands/renameConditionTagCommand";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-rename-tag-"));
  await fs.mkdir(path.join(root, "Project", "ConditionTagSets"), { recursive: true });
  await fs.mkdir(path.join(root, "Project", "Targets"), { recursive: true });
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult PreviewConditionalExpression="include[Default.Beta]" />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "ConditionTagSets", "Default.flcts"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultConditionTagSet>\n  <ConditionTag Name="Beta" BackgroundColor="#2196f3" />\n  <ConditionTag Name="BetaTesting" BackgroundColor="#03a9f4" />\n</CatapultConditionTagSet>\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "ConditionTagSets", "Audience.flcts"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultConditionTagSet>\n  <ConditionTag Name="Beta" BackgroundColor="#9c27b0" />\n</CatapultConditionTagSet>\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "Targets", "Web.fltar"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultTarget ConditionExpression="include[Default.Beta] AND exclude[Default.Internal]" />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Topics", "Topic.htm"),
    '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd">\n  <body>\n    <p MadCap:conditions="Default.Beta">beta paragraph</p>\n    <p MadCap:conditions="Default.BetaTesting">should not match</p>\n    <p MadCap:conditions="Audience.Beta">other set, should not match</p>\n    <p MadCap:conditions="Default.Public,Default.Beta">multi list</p>\n  </body>\n</html>\n',
    "utf8"
  );
  return root;
}

suite("Rename Condition Tag — scanner", () => {
  test("finds qualified token across topics, targets, .flprj, and .flcts source", async () => {
    const root = await makeProject();
    const occurrences = await scanProjectForOccurrences(root, "Default", "Beta", "BetaShipped");
    const byFile = new Map<string, number>();
    for (const occ of occurrences) {
      byFile.set(path.basename(occ.filePath), (byFile.get(path.basename(occ.filePath)) ?? 0) + 1);
    }
    assert.ok((byFile.get("Topic.htm") ?? 0) >= 2, "expected matches in Topic.htm (single + multi-list)");
    assert.ok((byFile.get("Web.fltar") ?? 0) >= 1, "expected match in Web.fltar");
    assert.ok((byFile.get("Sample.flprj") ?? 0) >= 1, "expected match in Sample.flprj");
    assert.strictEqual(byFile.get("Default.flcts") ?? 0, 1, "expected one Name= match in Default.flcts");
    assert.strictEqual(byFile.get("Audience.flcts"), undefined, "Audience.flcts should be untouched");
  });

  test("does not match BetaTesting (whole-word boundary)", async () => {
    const root = await makeProject();
    const occurrences = await scanProjectForOccurrences(root, "Default", "Beta", "BetaShipped");
    for (const occ of occurrences) {
      assert.ok(!occ.before.includes("BetaTesting"), `unexpected BetaTesting match: ${occ.before}`);
    }
  });

  test("does not match Audience.Beta when renaming Default.Beta", async () => {
    const root = await makeProject();
    const occurrences = await scanProjectForOccurrences(root, "Default", "Beta", "BetaShipped");
    for (const occ of occurrences) {
      // Topic.htm has Audience.Beta in line 6 — make sure we never picked it.
      assert.ok(!occ.before.includes("Audience.Beta"));
    }
  });

  test("rewrites the matching .flcts Name= attribute", async () => {
    const root = await makeProject();
    const occurrences = await scanProjectForOccurrences(root, "Default", "Beta", "BetaShipped");
    const flctsOcc = occurrences.find((occ) => occ.filePath.endsWith("Default.flcts"));
    assert.ok(flctsOcc, "expected .flcts occurrence");
    assert.ok(flctsOcc!.before.toLowerCase().includes("name=\"beta\""));
    assert.ok(flctsOcc!.after.toLowerCase().includes("name=\"betashipped\""));
  });

  test("returns nothing when there are no matches", async () => {
    const root = await makeProject();
    const occurrences = await scanProjectForOccurrences(root, "Default", "Nonexistent", "NewName");
    assert.deepStrictEqual(occurrences, []);
  });
});
