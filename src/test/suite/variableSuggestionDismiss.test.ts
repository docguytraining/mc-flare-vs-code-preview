import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FlareProjectResolver } from "../../core/flareProjectResolver";
import { DismissalStore } from "../../diagnostics/dismissalStore";
import { VariableSuggestionEngine } from "../../language/variableSuggestionEngine";

const FIXTURE_ROOT = path.resolve(__dirname, "../../../test/fixtures/sample-project");
const SIDECAR_PATH = path.join(FIXTURE_ROOT, ".vscode", "flare-preview.json");

async function clearSidecar(): Promise<void> {
  await fs.unlink(SIDECAR_PATH).catch(() => undefined);
}

suite("VariableSuggestionEngine - sidecar dismissals + case sensitivity", () => {
  test("DismissalStore round-trips a dismissal through the sidecar file", async () => {
    await clearSidecar();
    try {
      const resolver = new FlareProjectResolver();
      const topicUri = vscode.Uri.file(path.join(FIXTURE_ROOT, "Content", "Topics", "Overview.htm"));
      const projectContext = await resolver.resolveForFile(topicUri);
      assert.ok(projectContext);

      const store = new DismissalStore();
      assert.deepStrictEqual(await store.getDismissedVariables(projectContext!, topicUri), []);

      await store.dismissForTopic(projectContext!, topicUri, "Vendor");
      const after = await store.getDismissedVariables(projectContext!, topicUri);
      assert.deepStrictEqual(after, ["Vendor"]);

      // Persisted JSON shape
      const raw = await fs.readFile(SIDECAR_PATH, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, {
        topicDismissals: {
          "Content/Topics/Overview.htm": ["Vendor"]
        }
      });
    } finally {
      await clearSidecar();
    }
  });

  test("renameTopic moves an entry to the new path", async () => {
    await clearSidecar();
    try {
      const resolver = new FlareProjectResolver();
      const topicUri = vscode.Uri.file(path.join(FIXTURE_ROOT, "Content", "Topics", "Overview.htm"));
      const renamedUri = vscode.Uri.file(path.join(FIXTURE_ROOT, "Content", "Topics", "Renamed.htm"));
      const projectContext = await resolver.resolveForFile(topicUri);
      const store = new DismissalStore();

      await store.dismissForTopic(projectContext!, topicUri, "Vendor");
      await store.renameTopic(projectContext!, topicUri, renamedUri);

      assert.deepStrictEqual(await store.getDismissedVariables(projectContext!, topicUri), []);
      assert.deepStrictEqual(
        await store.getDismissedVariables(projectContext!, renamedUri),
        ["Vendor"]
      );
    } finally {
      await clearSidecar();
    }
  });

  test("detectStaleEntries reports entries pointing at missing files", async () => {
    await clearSidecar();
    try {
      const resolver = new FlareProjectResolver();
      const topicUri = vscode.Uri.file(path.join(FIXTURE_ROOT, "Content", "Topics", "Overview.htm"));
      const ghostUri = vscode.Uri.file(path.join(FIXTURE_ROOT, "Content", "Topics", "DoesNotExist.htm"));
      const projectContext = await resolver.resolveForFile(topicUri);
      const store = new DismissalStore();

      await store.dismissForTopic(projectContext!, topicUri, "Vendor");
      await store.dismissForTopic(projectContext!, ghostUri, "Vendor");

      const stale = await store.detectStaleEntries(projectContext!);
      assert.deepStrictEqual(stale, ["Content/Topics/DoesNotExist.htm"]);
    } finally {
      await clearSidecar();
    }
  });

  test("case-sensitive matching: lowercased prose does not trigger an uppercased variable", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-case.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>The acme docs team is responsible for documentation.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-case-test");
    try {
      const engine = new VariableSuggestionEngine(
        collection,
        new FlareProjectResolver(),
        new DismissalStore()
      );
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      await engine.refresh(document);
      const diagnostics = collection.get(document.uri) ?? [];
      const hit = diagnostics.find(
        (diagnostic) => diagnostic.code === VariableSuggestionEngine.diagnosticCode
      );
      assert.strictEqual(hit, undefined, "lowercased prose should not match an uppercased variable");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });

  test("project-wide ignore list suppresses both qualified and bare map entries (regression: Test 9)", async () => {
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-projectwide.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>Published by ACME Docs.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-projectwide-test");
    const config = vscode.workspace.getConfiguration("flareToolkit");
    const originalIgnore = config.get<string[]>("suggestionIgnoreVariables", []) ?? [];
    try {
      const engine = new VariableSuggestionEngine(
        collection,
        new FlareProjectResolver(),
        new DismissalStore()
      );
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));

      // Baseline: ACME Docs should match the Vendor variable.
      await engine.refresh(document);
      const before = collection.get(document.uri) ?? [];
      assert.ok(
        before.some((diagnostic) => diagnostic.code === VariableSuggestionEngine.diagnosticCode),
        "expected a suggestion before the project-wide dismissal is recorded"
      );

      // Dismiss by the qualified form (`Sample.Vendor`). Before the fix, the
      // bare-name map entry `Vendor` would still end up in the reverse lookup
      // and the suggestion would stay.
      await config.update(
        "suggestionIgnoreVariables",
        ["Sample.Vendor"],
        vscode.ConfigurationTarget.Global
      );
      try {
        await engine.refresh(document);
        const after = collection.get(document.uri) ?? [];
        assert.strictEqual(
          after.length,
          0,
          "project-wide dismissal by qualified name should suppress the suggestion"
        );
      } finally {
        await config.update(
          "suggestionIgnoreVariables",
          originalIgnore,
          vscode.ConfigurationTarget.Global
        );
      }
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
    }
  });

  test("a sidecar dismissal suppresses suggestions for the named variable in that topic", async () => {
    await clearSidecar();
    const scratchPath = path.join(FIXTURE_ROOT, "Content", "Topics", "__scratch-marker.htm");
    await fs.writeFile(
      scratchPath,
      [
        "<html>",
        "  <body>",
        "    <p>Published by ACME Docs.</p>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const collection = vscode.languages.createDiagnosticCollection("flare-sidecar-test");
    try {
      const resolver = new FlareProjectResolver();
      const store = new DismissalStore();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(scratchPath));
      const projectContext = await resolver.resolveForFile(document.uri);
      assert.ok(projectContext);

      // Without dismissal: ACME Docs should match Vendor.
      const engine = new VariableSuggestionEngine(collection, resolver, store);
      await engine.refresh(document);
      const before = collection.get(document.uri) ?? [];
      assert.ok(
        before.some((diagnostic) => diagnostic.code === VariableSuggestionEngine.diagnosticCode),
        "expected a suggestion before the dismissal is recorded"
      );

      // After dismissal: should be empty.
      await store.dismissForTopic(projectContext!, document.uri, "Vendor");
      await engine.refresh(document);
      const after = collection.get(document.uri) ?? [];
      assert.strictEqual(after.length, 0, "sidecar dismissal should suppress the suggestion");
    } finally {
      collection.dispose();
      await fs.unlink(scratchPath).catch(() => undefined);
      await clearSidecar();
    }
  });
});
