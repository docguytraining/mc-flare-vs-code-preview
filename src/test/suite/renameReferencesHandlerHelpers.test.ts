import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  expandIfDirectoryRename,
  pruneExpired
} from "../../commands/renameReferencesEventHelpers";

/**
 * Unit tests for the helpers behind the rename references handler. The
 * full integration path runs inside the VS Code event loop and is hard to
 * drive from a Mocha test, but the two helpers — expanding a folder
 * rename into per-file renames, and pruning expired entries from the
 * delete-event cache — are pure (or filesystem-only) and worth covering
 * directly.
 *
 * Issues 6 and 7 (drag-drop and folder rename triggers) are exercised
 * here through the helper they share.
 */
suite("renameReferencesHandler helpers", () => {
  suite("expandIfDirectoryRename", () => {
    let scratch: string;

    setup(async () => {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flare-rename-helpers-"));
    });

    teardown(async () => {
      await fs.rm(scratch, { recursive: true, force: true });
    });

    test("returns one rename per file when the new path is a directory", async () => {
      const newDir = path.join(scratch, "renamed-folder");
      await fs.mkdir(newDir);
      await fs.writeFile(path.join(newDir, "one.htm"), "<html />", "utf8");
      await fs.writeFile(path.join(newDir, "two.htm"), "<html />", "utf8");

      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "old-folder"),
        newDir
      );
      assert.strictEqual(expanded.length, 2);
      const oldPaths = expanded.map((r) => r.oldPath).sort();
      assert.deepStrictEqual(
        oldPaths,
        [path.join(scratch, "old-folder", "one.htm"), path.join(scratch, "old-folder", "two.htm")].sort()
      );
      const newPaths = expanded.map((r) => r.newPath).sort();
      assert.deepStrictEqual(
        newPaths,
        [path.join(newDir, "one.htm"), path.join(newDir, "two.htm")].sort()
      );
    });

    test("recurses into nested subdirectories", async () => {
      const newDir = path.join(scratch, "renamed-folder");
      await fs.mkdir(path.join(newDir, "Sub"), { recursive: true });
      await fs.writeFile(path.join(newDir, "top.htm"), "<html />", "utf8");
      await fs.writeFile(path.join(newDir, "Sub", "nested.htm"), "<html />", "utf8");

      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "old-folder"),
        newDir
      );
      assert.strictEqual(expanded.length, 2);
      const oldPaths = expanded.map((r) => r.oldPath).sort();
      assert.deepStrictEqual(oldPaths, [
        path.join(scratch, "old-folder", "Sub", "nested.htm"),
        path.join(scratch, "old-folder", "top.htm")
      ]);
    });

    test("preserves the relative path between old and new directories", async () => {
      const newDir = path.join(scratch, "Dest");
      await fs.mkdir(path.join(newDir, "deep", "deeper"), { recursive: true });
      await fs.writeFile(
        path.join(newDir, "deep", "deeper", "leaf.flsnp"),
        "<html />",
        "utf8"
      );

      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "Source"),
        newDir
      );
      assert.strictEqual(expanded.length, 1);
      assert.strictEqual(
        expanded[0].oldPath,
        path.join(scratch, "Source", "deep", "deeper", "leaf.flsnp")
      );
      assert.strictEqual(
        expanded[0].newPath,
        path.join(scratch, "Dest", "deep", "deeper", "leaf.flsnp")
      );
    });

    test("returns an empty array when the new path doesn't exist", async () => {
      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "old"),
        path.join(scratch, "doesNotExist")
      );
      assert.deepStrictEqual(expanded, []);
    });

    test("returns an empty array when the new path is a file (single-file rename)", async () => {
      const filePath = path.join(scratch, "single.htm");
      await fs.writeFile(filePath, "<html />", "utf8");
      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "old.htm"),
        filePath
      );
      assert.deepStrictEqual(expanded, []);
    });

    test("skips Output and Temporary directories the way the scanner does", async () => {
      const newDir = path.join(scratch, "Project");
      await fs.mkdir(path.join(newDir, "Output"), { recursive: true });
      await fs.mkdir(path.join(newDir, "Topics"), { recursive: true });
      await fs.writeFile(path.join(newDir, "Output", "build.htm"), "<html />", "utf8");
      await fs.writeFile(path.join(newDir, "Topics", "real.htm"), "<html />", "utf8");

      const expanded = await expandIfDirectoryRename(
        path.join(scratch, "OldProject"),
        newDir
      );
      assert.strictEqual(expanded.length, 1);
      assert.strictEqual(
        expanded[0].newPath,
        path.join(newDir, "Topics", "real.htm")
      );
    });
  });

  suite("pruneExpired", () => {
    test("removes entries whose expiry has passed", () => {
      const past = Date.now() - 1000;
      const future = Date.now() + 60_000;
      const store = new Map<string, { fsPath: string; expiresAt: number }[]>([
        ["a.htm", [{ fsPath: "/old/a.htm", expiresAt: past }]],
        [
          "b.htm",
          [
            { fsPath: "/old/b.htm", expiresAt: past },
            { fsPath: "/older/b.htm", expiresAt: future }
          ]
        ]
      ]);
      pruneExpired(store);
      assert.strictEqual(store.has("a.htm"), false, "fully expired entry should be removed");
      assert.strictEqual(store.get("b.htm")?.length, 1, "still-fresh entry should survive");
      assert.strictEqual(store.get("b.htm")?.[0].fsPath, "/older/b.htm");
    });

    test("leaves a fully fresh store untouched", () => {
      const future = Date.now() + 60_000;
      const store = new Map<string, { fsPath: string; expiresAt: number }[]>([
        ["a.htm", [{ fsPath: "/x/a.htm", expiresAt: future }]]
      ]);
      pruneExpired(store);
      assert.strictEqual(store.size, 1);
      assert.strictEqual(store.get("a.htm")?.length, 1);
    });
  });
});
