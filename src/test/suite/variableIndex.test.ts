import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  VariableIndex,
  findVariablesByValue,
  setNameFromFlvarPath
} from "../../flare/variableIndex";
import { FlareProjectContext } from "../../core/types";

async function makeProject(): Promise<FlareProjectContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-variable-index-"));
  const variableSetsDir = path.join(root, "Project", "VariableSets");
  await fs.mkdir(variableSetsDir, { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(variableSetsDir, "UI.flvar"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultVariableSet>\n  <Variable Name="ProductName">Trust Protection Foundation</Variable>\n  <Variable Name="CompanyName">DocGuy Training</Variable>\n</CatapultVariableSet>\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(variableSetsDir, "Copyright.flvar"),
    '<?xml version="1.0" encoding="utf-8"?>\n<CatapultVariableSet>\n  <Variable Name="Year">2026</Variable>\n</CatapultVariableSet>\n',
    "utf8"
  );
  return {
    projectFile: vscode.Uri.file(path.join(root, "Sample.flprj")),
    projectRoot: vscode.Uri.file(root),
    variableFiles: [
      vscode.Uri.file(path.join(variableSetsDir, "UI.flvar")),
      vscode.Uri.file(path.join(variableSetsDir, "Copyright.flvar"))
    ],
    referencedStylesheets: []
  };
}

suite("VariableIndex", () => {
  test("getEntries returns one row per variable, qualified with the set name", async () => {
    const context = await makeProject();
    const index = new VariableIndex();
    const entries = await index.getEntries(context);
    const names = entries.map((entry) => entry.qualifiedName).sort();
    assert.deepStrictEqual(names, [
      "Copyright.Year",
      "UI.CompanyName",
      "UI.ProductName"
    ]);
  });

  test("getEntries captures set name, bare name, and value", async () => {
    const context = await makeProject();
    const index = new VariableIndex();
    const entries = await index.getEntries(context);
    const product = entries.find((entry) => entry.bareName === "ProductName");
    assert.ok(product);
    assert.strictEqual(product!.setName, "UI");
    assert.strictEqual(product!.qualifiedName, "UI.ProductName");
    assert.strictEqual(product!.value, "Trust Protection Foundation");
  });

  test("getEntries drops bare-name duplicates", async () => {
    const context = await makeProject();
    const index = new VariableIndex();
    const entries = await index.getEntries(context);
    const bareKeys = entries.filter((entry) => !entry.qualifiedName.includes("."));
    assert.strictEqual(bareKeys.length, 0);
  });
});

suite("findVariablesByValue", () => {
  const entries = [
    { qualifiedName: "UI.Name", setName: "UI", bareName: "Name", value: "DocGuy" },
    { qualifiedName: "Other.Name", setName: "Other", bareName: "Name", value: "DocGuy" },
    { qualifiedName: "UI.City", setName: "UI", bareName: "City", value: "Austin" }
  ];

  test("returns every variable whose trimmed value matches the literal", () => {
    const matches = findVariablesByValue(entries, "DocGuy");
    assert.strictEqual(matches.length, 2);
    assert.deepStrictEqual(
      matches.map((m) => m.qualifiedName).sort(),
      ["Other.Name", "UI.Name"]
    );
  });

  test("ignores surrounding whitespace on the literal", () => {
    const matches = findVariablesByValue(entries, "  DocGuy  ");
    assert.strictEqual(matches.length, 2);
  });

  test("returns an empty array when nothing matches", () => {
    assert.deepStrictEqual(findVariablesByValue(entries, "Nobody"), []);
  });

  test("returns an empty array for an empty literal", () => {
    assert.deepStrictEqual(findVariablesByValue(entries, "   "), []);
  });
});

suite("setNameFromFlvarPath", () => {
  test("returns the basename without the extension", () => {
    assert.strictEqual(
      setNameFromFlvarPath(path.normalize("/proj/Project/VariableSets/UI.flvar")),
      "UI"
    );
  });
});
