import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { DismissalStore } from "../../diagnostics/dismissalStore";
import { FlareProjectContext } from "../../core/types";

async function makeTempProject(): Promise<FlareProjectContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-store-"));
  return {
    projectFile: vscode.Uri.file(path.join(root, "Sample.flprj")),
    projectRoot: vscode.Uri.file(root),
    variableFiles: [],
    referencedStylesheets: []
  };
}

suite("DismissalStore — preview target persistence", () => {
  test("getPreviewTarget returns undefined when no sidecar exists", async () => {
    const ctx = await makeTempProject();
    const store = new DismissalStore();
    assert.strictEqual(await store.getPreviewTarget(ctx), undefined);
  });

  test("setPreviewTarget creates the sidecar and round-trips", async () => {
    const ctx = await makeTempProject();
    const store = new DismissalStore();
    await store.setPreviewTarget(ctx, "target:Project/Targets/PublicWeb.fltar");
    const got = await store.getPreviewTarget(ctx);
    assert.strictEqual(got, "target:Project/Targets/PublicWeb.fltar");
  });

  test("setPreviewTarget(undefined) clears the entry", async () => {
    const ctx = await makeTempProject();
    const store = new DismissalStore();
    await store.setPreviewTarget(ctx, "target:foo");
    await store.setPreviewTarget(ctx, undefined);
    assert.strictEqual(await store.getPreviewTarget(ctx), undefined);
  });

  test("setPreviewTarget does not disturb existing topic dismissals", async () => {
    const ctx = await makeTempProject();
    const store = new DismissalStore();
    const topicUri = vscode.Uri.file(path.join(ctx.projectRoot.fsPath, "Content", "Foo.htm"));
    await store.dismissForTopic(ctx, topicUri, "UI.user");
    await store.setPreviewTarget(ctx, "target:foo");
    const after = await store.getDismissedVariables(ctx, topicUri);
    assert.deepStrictEqual(after, ["UI.user"]);
    assert.strictEqual(await store.getPreviewTarget(ctx), "target:foo");
  });

  test("sidecar file is valid JSON with both keys when both are set", async () => {
    const ctx = await makeTempProject();
    const store = new DismissalStore();
    const topicUri = vscode.Uri.file(path.join(ctx.projectRoot.fsPath, "Content", "Foo.htm"));
    await store.dismissForTopic(ctx, topicUri, "UI.user");
    await store.setPreviewTarget(ctx, "target:bar");
    const sidecar = path.join(ctx.projectRoot.fsPath, ".vscode", "flare-preview.json");
    const text = await fs.readFile(sidecar, "utf8");
    const parsed = JSON.parse(text) as { previewTarget?: string; topicDismissals: Record<string, string[]> };
    assert.strictEqual(parsed.previewTarget, "target:bar");
    assert.ok(parsed.topicDismissals);
  });
});
