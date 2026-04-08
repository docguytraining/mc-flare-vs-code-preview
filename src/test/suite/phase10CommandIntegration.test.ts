import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AddConditionCodeActionProvider } from "../../language/addConditionCodeActionProvider";

/**
 * End-to-end integration tests for the Phase 10 commands. Each test sets up a
 * minimal Flare project on disk, opens the active topic in an editor, stubs
 * the relevant `vscode.window.showQuickPick` / `showInputBox` calls so the
 * command runs without UI, executes the command, and asserts the resulting
 * document edit. Companion code-action providers are also smoke-tested here.
 */

const FLCTS = `<?xml version="1.0" encoding="utf-8"?>
<CatapultConditionTagSet>
  <ConditionTag Name="Public" BackgroundColor="#4caf50" Comment="public" />
  <ConditionTag Name="Internal" Comment="internal" />
</CatapultConditionTagSet>
`;

interface ProjectFixture {
  root: string;
  topicUri: vscode.Uri;
}

async function makeProject(activeTopicContent: string): Promise<ProjectFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flare-phase10-int-"));
  await fs.mkdir(path.join(root, "Project", "ConditionTagSets"), { recursive: true });
  await fs.mkdir(path.join(root, "Content", "Topics"), { recursive: true });
  await fs.mkdir(path.join(root, "Content", "Resources", "Snippets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Sample.flprj"),
    '<?xml version="1.0" encoding="utf-8"?>\n<Catapult />\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Project", "ConditionTagSets", "Default.flcts"),
    FLCTS,
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Topics", "Other.htm"),
    "<html><body><h1>Another Topic</h1><p>body</p></body></html>",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "Content", "Resources", "Snippets", "intro.flsnp"),
    "<html><body><p>Intro snippet</p></body></html>",
    "utf8"
  );
  const topicPath = path.join(root, "Content", "Topics", "Active.htm");
  await fs.writeFile(topicPath, activeTopicContent, "utf8");
  return { root, topicUri: vscode.Uri.file(topicPath) };
}

interface QuickPickStub {
  // Returns the picked item(s) given the items shown. Receives the call index
  // so multi-step pickers can branch on which prompt is showing.
  pick(items: readonly vscode.QuickPickItem[], callIndex: number): unknown;
}

interface InputBoxStub {
  next(callIndex: number): string | undefined;
}

function withStubs<T>(
  quickPick: QuickPickStub | undefined,
  inputBox: InputBoxStub | undefined,
  body: () => Promise<T>
): Promise<T> {
  const originalQp = vscode.window.showQuickPick;
  const originalIb = vscode.window.showInputBox;
  let qpCalls = 0;
  let ibCalls = 0;
  if (quickPick) {
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
      itemsOrPromise: vscode.QuickPickItem[] | Thenable<vscode.QuickPickItem[]>
    ): Promise<unknown> => {
      const items = await Promise.resolve(itemsOrPromise);
      const result = quickPick.pick(items, qpCalls);
      qpCalls += 1;
      return result;
    };
  }
  if (inputBox) {
    (vscode.window as unknown as { showInputBox: unknown }).showInputBox = async () => {
      const result = inputBox.next(ibCalls);
      ibCalls += 1;
      return result;
    };
  }
  return body().finally(() => {
    (vscode.window as unknown as { showQuickPick: typeof originalQp }).showQuickPick = originalQp;
    (vscode.window as unknown as { showInputBox: typeof originalIb }).showInputBox = originalIb;
  });
}

async function openTopic(uri: vscode.Uri): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preview: false });
}

suite("AddConditionCodeActionProvider — provideCodeActions", () => {
  test("offers the action when the cursor sits inside an element body", async () => {
    const { topicUri } = await makeProject("<p>Hello world</p>");
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new AddConditionCodeActionProvider();
    // Cursor inside "Hello".
    const range = new vscode.Range(new vscode.Position(0, 6), new vscode.Position(0, 6));
    const actions = provider.provideCodeActions(document, range);
    assert.ok(actions, "expected an action when the cursor is inside an element body");
    assert.strictEqual(actions!.length, 1);
    assert.strictEqual(actions![0].command?.command, "flare.addConditionToElement");
    // Args: [uri, tagRange, existingConditions]
    const args = actions![0].command!.arguments!;
    assert.strictEqual((args[0] as vscode.Uri).toString(), document.uri.toString());
    assert.ok(args[1] instanceof vscode.Range);
    assert.strictEqual(args[2], undefined);
  });

  test("returns undefined for a non-Flare document", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "plaintext",
      content: "<p>plain</p>"
    });
    const provider = new AddConditionCodeActionProvider();
    const range = new vscode.Range(new vscode.Position(0, 4), new vscode.Position(0, 4));
    assert.strictEqual(provider.provideCodeActions(document, range), undefined);
  });

  test("forwards the existing conditions value when the enclosing tag already has one", async () => {
    const { topicUri } = await makeProject(
      '<p MadCap:conditions="Default.Public">Hello</p>'
    );
    const document = await vscode.workspace.openTextDocument(topicUri);
    const provider = new AddConditionCodeActionProvider();
    const range = new vscode.Range(new vscode.Position(0, 40), new vscode.Position(0, 40));
    const actions = provider.provideCodeActions(document, range);
    assert.ok(actions);
    assert.strictEqual(actions![0].command!.arguments![2], "Default.Public");
  });
});

suite("flare.addConditionToElement — command", () => {
  test("adds a MadCap:conditions attribute on the chosen element", async () => {
    const { topicUri } = await makeProject("<p>Hello world</p>");
    const editor = await openTopic(topicUri);
    const tagRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 3));
    await withStubs(
      {
        pick: (items) => {
          // Multi-select returns the array of items the user kept.
          const target = (items as Array<vscode.QuickPickItem & { label: string }>).find(
            (i) => i.label === "Default.Public"
          );
          return target ? [target] : [];
        }
      },
      undefined,
      () =>
        Promise.resolve(
          vscode.commands.executeCommand(
            "flare.addConditionToElement",
            editor.document.uri,
            tagRange,
            undefined
          )
        )
    );
    const text = editor.document.getText();
    assert.match(text, /<p MadCap:conditions="Default\.Public">Hello world<\/p>/);
  });
});

suite("flare.insertSnippet — command", () => {
  test("inserts a MadCap:snippetBlock with the chosen snippet's relative path", async () => {
    const { topicUri } = await makeProject("<p>before</p>\n<p>after</p>");
    const editor = await openTopic(topicUri);
    // Park the cursor between the two paragraphs.
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
    await withStubs(
      { pick: (items) => items[0] },
      undefined,
      () => Promise.resolve(vscode.commands.executeCommand("flare.insertSnippet"))
    );
    const text = editor.document.getText();
    assert.match(
      text,
      /<MadCap:snippetBlock src="\.\.\/Resources\/Snippets\/intro\.flsnp" \/>/
    );
  });
});

suite("flare.insertXref — command", () => {
  test("inserts a MadCap:xref pointing at the chosen topic", async () => {
    const { topicUri } = await makeProject("<p>see </p>");
    const editor = await openTopic(topicUri);
    // Cursor between "see " and "</p>" so the link inserts mid-paragraph.
    editor.selection = new vscode.Selection(new vscode.Position(0, 7), new vscode.Position(0, 7));
    await withStubs(
      {
        pick: (items, callIndex) => {
          if (callIndex === 0) {
            // Topic picker — pick the "Other" topic, not the active one.
            const other = (items as Array<vscode.QuickPickItem & { description?: string }>).find(
              (i) => (i.description ?? "").includes("Other.htm")
            );
            return other;
          }
          // Bookmark picker (only shown if bookmarks exist) — Other.htm has none, so this never fires.
          return items[0];
        }
      },
      undefined,
      () => Promise.resolve(vscode.commands.executeCommand("flare.insertXref"))
    );
    const text = editor.document.getText();
    assert.match(text, /<MadCap:xref href="Other\.htm">[^<]+<\/MadCap:xref>/);
  });
});

suite("flare.wrapSelectionAsXref — command", () => {
  test("wraps the supplied range with a MadCap:xref using the selection as link text", async () => {
    const { topicUri } = await makeProject("<p>see the API docs</p>");
    const editor = await openTopic(topicUri);
    const range = new vscode.Range(new vscode.Position(0, 7), new vscode.Position(0, 14));
    await withStubs(
      {
        pick: (items, callIndex) => {
          if (callIndex === 0) {
            const other = (items as Array<vscode.QuickPickItem & { description?: string }>).find(
              (i) => (i.description ?? "").includes("Other.htm")
            );
            return other;
          }
          return items[0];
        }
      },
      undefined,
      () =>
        Promise.resolve(
          vscode.commands.executeCommand(
            "flare.wrapSelectionAsXref",
            editor.document.uri,
            range
          )
        )
    );
    const text = editor.document.getText();
    // The original "the API" prose became the link text.
    assert.match(text, /<MadCap:xref href="Other\.htm">the API<\/MadCap:xref>/);
  });
});

suite("flare.extractSelectionAsSnippet — command", () => {
  test("creates a new .flsnp file and replaces the selection with a snippetBlock reference", async () => {
    const { root, topicUri } = await makeProject(
      "<body>\n  <p>Hello</p>\n  <p>World</p>\n</body>"
    );
    const editor = await openTopic(topicUri);
    const range = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(2, 14));
    editor.selection = new vscode.Selection(range.start, range.end);
    await withStubs(
      {
        pick: (items, callIndex) => {
          if (callIndex === 0) {
            // Folder picker — pick the snippets root (first item).
            return items[0];
          }
          return items[0];
        }
      },
      { next: () => "extracted-block" },
      () =>
        Promise.resolve(
          vscode.commands.executeCommand(
            "flare.extractSelectionAsSnippet",
            editor.document.uri,
            range
          )
        )
    );
    const text = editor.document.getText();
    assert.match(
      text,
      /<MadCap:snippetBlock src="\.\.\/Resources\/Snippets\/extracted-block\.flsnp" \/>/
    );
    const newSnippetPath = path.join(
      root,
      "Content",
      "Resources",
      "Snippets",
      "extracted-block.flsnp"
    );
    const onDisk = await fs.readFile(newSnippetPath, "utf8");
    assert.ok(onDisk.includes("<p>Hello</p>"));
    assert.ok(onDisk.includes("<p>World</p>"));
  });

  // Issue 5 — when the lifted selection contains nested local references
  // (a nested snippet, an image, an xref), the new .flsnp file must end up
  // with each of those paths re-anchored to its own directory. Without
  // the fix the inner src/href values stayed relative to the source
  // topic, and any move of the snippet broke the references.
  test("rewrites nested image/xref/snippet references to be relative to the new snippet file", async () => {
    const { root, topicUri } = await makeProject(
      [
        "<body>",
        "  <p>",
        '    <img src="../Resources/Images/diagram.png" alt="diagram" />',
        '    See <MadCap:xref href="Other.htm">other</MadCap:xref>',
        '    <MadCap:snippet src="../Resources/Snippets/intro.flsnp" />',
        "  </p>",
        "</body>"
      ].join("\n")
    );
    // Pre-create the referenced image so paths look real (not strictly
    // necessary for the test — the rewriter is path-shape based — but it
    // matches a realistic setup).
    await fs.mkdir(path.join(root, "Content", "Resources", "Images"), { recursive: true });
    await fs.writeFile(path.join(root, "Content", "Resources", "Images", "diagram.png"), "");

    const editor = await openTopic(topicUri);
    // Select the entire <p>…</p> block (line 1 col 2 — line 5 col 8).
    const range = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(5, 6));
    editor.selection = new vscode.Selection(range.start, range.end);

    await withStubs(
      {
        pick: (items, callIndex) => {
          if (callIndex === 0) {
            // Folder picker — pick the snippets root.
            return items[0];
          }
          return items[0];
        }
      },
      { next: () => "lifted-block" },
      () =>
        Promise.resolve(
          vscode.commands.executeCommand(
            "flare.extractSelectionAsSnippet",
            editor.document.uri,
            range
          )
        )
    );

    const newSnippetPath = path.join(
      root,
      "Content",
      "Resources",
      "Snippets",
      "lifted-block.flsnp"
    );
    const onDisk = await fs.readFile(newSnippetPath, "utf8");

    // Image: source topic referenced `../Resources/Images/diagram.png`
    // (relative to Content/Topics/). From the new snippet file at
    // Content/Resources/Snippets/lifted-block.flsnp, the same target is
    // `../Images/diagram.png`.
    assert.match(onDisk, /src="\.\.\/Images\/diagram\.png"/);

    // Xref: source topic referenced `Other.htm` (sibling). From the new
    // snippet file the same target is `../../Topics/Other.htm`.
    assert.match(onDisk, /href="\.\.\/\.\.\/Topics\/Other\.htm"/);

    // Nested snippet: source topic referenced
    // `../Resources/Snippets/intro.flsnp`. From the new snippet file
    // (which lives next to intro.flsnp) the same target is just
    // `intro.flsnp`.
    assert.match(onDisk, /src="intro\.flsnp"/);
  });
});
