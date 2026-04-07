# Toolkit for MadCap Flare

An unofficial open-source toolkit for editing and previewing existing MadCap Flare™ topic files in Visual Studio Code. **Requires a MadCap Flare license** — this extension is a complement to Flare, not a replacement for it.

## Why this extension exists

MadCap Flare is the authoring environment. Topics are written there, project structure is managed there, builds happen there, conditional output and target compilation all live there. **This extension does none of those things.**

What it does is make the *editing pass* — the part where you're fixing typos, adjusting prose, reviewing variables, checking cross-references, validating links — pleasant to do in Visual Studio Code instead of having to round-trip back to the Flare desktop application every time. Many writers spend hours per day in this editing pass, often reviewing topics from a peer's branch or making small content changes between Flare sessions. This toolkit is for that workflow.

It is **not** a replacement for Flare. You need a MadCap Flare license to author topics, manage projects, build outputs, and ship documentation. This toolkit only edits and previews source files that Flare itself produced.

VS Code's built-in HTML preview doesn't understand any of Flare's proprietary tags or stylesheet conventions, so a Flare topic looks half-broken when you preview it. The toolkit fills that gap. It walks up from your topic to find the nearest `.flprj`, parses every `.flvar` in the project, applies the master and auxiliary stylesheets the way Flare's compiler would, transforms `<MadCap:variable>`, `<MadCap:conditionalBlock>`, `<MadCap:dropDown>`, `<MadCap:snippet>`, and `<MadCap:xref>` into real HTML, and renders the result in a webview that updates as you type.

## Features

### Preview rendering
- **Project discovery** — walks upward from any open topic to locate the nearest `.flprj`. Skips macOS `._*` AppleDouble files. Caches per project root.
- **Variable resolution** — recursively scans `Project/VariableSets/**/*.flvar`, parses `<Variable>` element-text values (the Flare canonical format), and resolves both qualified (`UI.ProductName`) and bare (`ProductName`) references in topics.
- **Stylesheet aggregation** — loads the master stylesheet referenced from `.flprj` plus any sheets under `Content/Resources/Stylesheets/` and `Content/Resources/TableStyles/`. `@import` rules are inlined.
- **Flare CSS translation** — converts `mc-auto-number-format` declarations into real `:before { content: … }` rules, so NOTE/TIP/WARNING/IMPORTANT/CAUTION/EXAMPLE admonition labels appear in the preview without waiting for a Flare build.
- **MadCap transforms** — variables, conditional blocks, drop-down/expandable regions, snippet includes (relative to the topic and to the project root), and cross-references. `<MadCap:keyword>` is dropped silently. `<MadCap:annotation>` is unwrapped while preserving its inner content. Unknown MadCap tags render as inline `[Unsupported MadCap:tagName]` markers and emit a structured warning instead of breaking the preview.
- **Refresh engine** — immediate refresh on save or dependency change, 800 ms debounced typing refresh (configurable), single-in-flight renders with stale cancellation, and a 10 s coalescing safeguard so rapid edits never starve the preview.
- **Click-through cross-references** — clicking a `<MadCap:xref>` link in the preview opens the target topic in the editor and reveals the anchor if one is present, restricted to paths inside the current workspace folder.
- **Strict security model** — Content Security Policy with nonced scripts, workspace-scoped `localResourceRoots`, webview URI rewriting for local images and links, and an HTML/CSS sanitizer that strips `<script>`, `<iframe>`, `<object>`, inline `<style>`, meta refresh, inline event handlers, `javascript:` and non-image `data:` URLs, plus external CSS `@import` and `url()` references.

### Editing assistance
- **Variable inlay hints** — every `<MadCap:variable>` reference shows its resolved value inline next to the tag, so you can see what a topic actually says without running a build.
- **Variable name completion** — typing inside `<MadCap:variable name="…">` opens a completion list of every variable in the project (qualified and bare forms).
- **Value-prefix completion** — start typing prose that matches the beginning of a variable's value (e.g. `Trust Pro` for `Trust Protection Foundation`) and the completion popup offers to replace the typed text with the canonical `<MadCap:variable name="…" />` reference. Multi-word matching with longest-match wins, so mid-paragraph typing works the same as start-of-paragraph.
- **Literal-to-variable suggestions** — case-sensitive scan finds prose literals that exactly match a known variable value. Each match becomes an Information diagnostic with three quick-fix actions: replace with the variable, dismiss for this topic, dismiss project-wide. Skips text inside existing MadCap tags, attributes, and comments.
- **Per-topic dismissal sidecar** — "Never suggest 'X' in this topic" writes to `<projectRoot>/.vscode/flare-preview.json` instead of touching the topic file. Source-controllable, reviewable, automatically migrated when you rename a topic inside VS Code, and stale entries (pointing at deleted topics) are detected on activation and surfaced as a warning notification.
- **Project-wide dismissal** — "Never suggest 'X' anywhere in this project" writes to `flarePreview.suggestionIgnoreVariables` in workspace settings.
- **Insert Cross-Reference command** — opens a project-wide quick pick of every topic indexed by its first `<h1>`, then a follow-up picker for the bookmark to link to. Inserts `<MadCap:xref href="…">link text</MadCap:xref>` at the cursor with the link text preselected for editing.
- **Cross-reference completion** — typing inside `<MadCap:xref>` or `<a>` `href="…"` attributes suggests project topics; typing `#` after a topic path lists bookmarks scanned from the target topic.
- **`[[` topic picker** — anywhere in flowing prose, type `[[` and IntelliSense opens a project-wide list of every topic. Pick one and the `[[` is replaced with a complete `<MadCap:xref>` tag pointing at the chosen topic, with the heading prefilled as link text.
- **Convert selection to cross-reference** — select prose, click the lightbulb, choose **Convert to cross-reference…**, and the selection is replaced with a `<MadCap:xref>` whose link text is your original selection. Same project-wide topic picker as the regular Insert command.
- **Tag-scaffolding snippet completions** — type `xref`, `cond`, `cblock`, `snip`, or `snipblock` to expand to a fully-formed `<MadCap:xref>`, `MadCap:conditions=""`, `<MadCap:conditionalBlock>`, `<MadCap:snippet />`, or `<MadCap:snippetBlock />` with tab stops in the right places.

### Snippet authoring
- **Insert Snippet command** — opens a project-wide quick pick of every `.flsnp` file under the project root, indexed by name, folder, and a one-line preview of the snippet body. Inserts `<MadCap:snippetBlock src="…" />` at the cursor with a portable forward-slash path computed relative to the topic.
- **`{{` snippet picker** — anywhere in flowing prose, type `{{` and IntelliSense opens the same project-wide snippet list. Pick one and the `{{` is replaced with a complete `<MadCap:snippetBlock>` tag pointing at the chosen snippet. Sibling to the `[[` cross-reference picker.
- **Snippet `src` completion** — typing inside `<MadCap:snippet src="…">`, `<MadCap:snippetBlock src="…">`, or `<MadCap:snippetText src="…">` lists every project snippet, ranked by path, with the body preview surfaced in the docs panel.
- **Extract selection as snippet** — select repeated prose, click the lightbulb, choose **Extract selection as snippet…**, and the toolkit prompts for a name and a destination folder under `Content/Resources/Snippets/`, creates the new `.flsnp` file with the canonical Flare skeleton, and replaces the selection with a `<MadCap:snippetBlock src="…" />` reference. Everything is one undo step. Selections that contain unbalanced markup are rejected so the parent topic can't be corrupted.

### Conditional text and target picker

- **Condition tag set index** — every `.flcts` file under `Project/ConditionTagSets` is parsed and indexed by qualified `<setName>.<tagName>`. Color and comment metadata are surfaced in completion documentation.
- **Target-aware preview** — the transform pipeline parses `MadCap:conditions=` on every element and hides anything the active target's expression excludes. Supports `include[A or B]`, `exclude[A and B]`, nested grouping, and `AND` between top-level clauses.
- **Target picker** — a "Target" label and "Change…" button appear in the preview header. Picking a target persists per project root in `.vscode/flare-preview.json`. The list always includes a synthetic *Show everything* (default) and *(Project default)* entry.
- **Condition badges** *(opt-in)* — turn on `flarePreview.showConditionBadges` to inject a small `madcap-condition-badge` pill inside every conditional element so you can see at a glance which tag gates each block.
- **Condition autocomplete** — typing inside `MadCap:conditions="…"` or `MadCap:conditionTagExpression="…"` opens a completion list of every qualified condition tag in the project. Each entry shows a small color swatch matching the tag's `BackgroundColor`, and accepting one re-triggers IntelliSense so you can chain a comma and pick the next tag without retyping anything.
- **Condition attribute-name completion** — inside any opening tag, typing a space surfaces `MadCap:conditions=""` and `MadCap:conditionTagExpression=""` as completion items. Accepting one drops the cursor between the quotes and immediately fires the value picker above.
- **"Add condition…" code action** — place the cursor anywhere inside an opening tag, click the lightbulb, choose **Add condition…**, and a multi-select quick pick of every project condition tag opens. Pre-checks any tags already on the element; on accept, the toolkit inserts (or extends) `MadCap:conditions="…"` on that tag in a single edit.
- **Condition validation** — unknown `<set>.<tag>` references raise `flare.condition-unresolved` warnings in the Problems panel.
- **Conditions discovery summary** — the preview's discovery section now lists every unique element-condition tag and snippet-condition tag referenced in the topic, with per-tag occurrence counts and a "hidden by active target" total.

### Cross-project rename references

- **Automatic rename refactoring** — renaming or moving any Flare-referenceable file inside VS Code (HTML topics, snippets, TOCs, alias files, browse sequences, master pages, glossaries, relationship tables, condition tag sets, targets, page layouts, skins, plus images, fonts, and PDFs) triggers a project-wide scan for references to the old path. The scanner reads every text-bearing project file (any `.fl*` extension plus `.htm`/`.html`) and matches against any reference attribute (`href`, `src`, `source`, `Link`, `xlink:href`, `File`, `Topic`).
- **Quick-pick refactor preview** — affected references appear in a multi-select quick pick with a `before → after` preview. Uncheck anything you want to leave alone, then press Enter to apply a single `WorkspaceEdit` rewriting every checked reference. Folder renames flatten internally into a batch of file renames so the same path serves both.
- **Style preservation** — project-root-relative refs (`/Content/foo.htm`) stay project-root-relative; sibling-relative refs (`../foo.htm`) stay relative.
- **`Flare: Find Stale References`** — for the case where the rename happened outside VS Code, this command scans the same files and surfaces stale references in the Problems panel.

### Link validation
- Every Flare topic is scanned for broken local references in `<MadCap:xref>`, `<a>`, `<img>`, `<link rel="stylesheet">`, `<MadCap:snippet>`, and `<MadCap:snippetBlock>`.
- Missing files appear as errors in the Problems panel; missing anchors as warnings; case-sensitivity drift as information notices (so case-sensitive Linux/CI environments don't surprise you later).
- External URLs (`http(s)://`, `mailto:`, `tel:`, `data:`) are skipped — the validator never makes network requests.

## Commands

All commands are listed under the **Flare Toolkit** category in the Command Palette.

| Command | Palette title | Default keybinding | Where |
|---|---|---|---|
| `flare.previewHtml` | **Flare Toolkit: Live Preview** | `Cmd+K P` / `Ctrl+K P` (chord) | Editor title bar (`.htm` / `.html`), Command Palette, Explorer context menu |
| `flare.insertXref` | **Flare Toolkit: Insert Cross-Reference** | — | Command Palette, editor context menu |
| `flare.pickPreviewTarget` | **Flare Toolkit: Pick Preview Target** | — | Command Palette, "Change…" button in preview header |
| `flare.validateAllTopics` | **Flare Toolkit: Validate All Topics** | — | Command Palette |
| `flare.findStaleReferences` | **Flare Toolkit: Find Stale References** | — | Command Palette |
| `flare.renameConditionTag` | **Flare Toolkit: Rename Condition Tag…** | — | Command Palette |
| `flare.insertSnippet` | **Flare Toolkit: Insert Snippet** | — | Command Palette, editor context menu |
| `flare.extractSelectionAsSnippet` | **Flare Toolkit: Extract Selection as Snippet…** | — | Command Palette, lightbulb on a non-empty selection |

The `Live Preview` keybinding is a **chord**: press and hold `Cmd` (or `Ctrl` on Windows/Linux), tap `K`, **release both**, then tap `P` alone. Press once to open the preview side-by-side with the topic; press again on the same topic to close it; press while editing a different topic to switch the preview to the new topic. The keybinding only fires inside `.htm` and `.html` files so it won't collide with other extensions in unrelated editors.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `flarePreview.autoRefreshOnSave` | `boolean` | `true` | Refresh the preview after saving an HTML topic or a dependency file (`.flprj`, `.flvar`, `.css`). |
| `flarePreview.typingDebounceMs` | `number` | `800` | Debounce delay for typing-driven preview refresh. Minimum 300 ms. |
| `flarePreview.inlayHints.variables` | `boolean` | `true` | Show the resolved value of each Flare variable reference as an inline hint. |
| `flarePreview.suggestVariableReplacements` | `boolean` | `true` | Suggest replacing literal text that matches a Flare variable value with a `<MadCap:variable>` reference. |
| `flarePreview.variableReplacementMinLength` | `number` | `4` | Minimum length of a variable value before it is used for literal-match suggestions. |
| `flarePreview.suggestionIgnoreVariables` | `string[]` | `[]` | Project-wide ignore list for variables that should never produce literal-match suggestions. Per-topic dismissals live in `.vscode/flare-preview.json` instead. |
| `flarePreview.validateLinks` | `boolean` | `true` | Validate local links, images, snippet sources, stylesheets, and MadCap cross-references in Flare topics. |
| `flarePreview.showConditionBadges` | `boolean` | `false` | Show a small pill badge inside every conditional element in the preview, listing the `MadCap:conditions` tags that gate it. |
| `flarePreview.showConditionGutter` | `boolean` | `true` | Show a colored square in the editor gutter on every line that contains a `MadCap:conditions` or `MadCap:conditionTagExpression` attribute. The square's color comes from the `BackgroundColor` of the matching `.flcts` entry. |

## Supported MadCap tags

| Tag | Status | Notes |
|---|---|---|
| `<MadCap:variable>` | Supported | Resolved against project `.flvar` files. Both qualified (`Set.Name`) and bare (`Name`) references. |
| `<MadCap:conditionalBlock>` | Supported | Baseline keyword suppression plus full target-aware evaluation via `MadCap:conditions=` on every element. The active target's `include[…]` / `exclude[…]` expression is honored. |
| `MadCap:conditions=` (any element) | Supported | Parsed on every element; hidden when the active target excludes the tag list. Inventoried in the preview's Conditions section. |
| `MadCap:conditionTagExpression=` (snippets) | Inventoried | Surfaced in the preview's Conditions section and validated against the project's condition tag index. |
| `<MadCap:dropDown>` / `<MadCap:expandableArea>` | Supported | Rendered as native `<details>` / `<summary>` using the hotspot text or `title` attribute. |
| `<MadCap:snippet>` / `<MadCap:snippetBlock>` | Supported | Resolved relative to the topic first, then the project root. Missing snippets render an inline warning marker. |
| `<MadCap:xref>` | Supported | Rendered as a clickable link that opens the target in the editor. Topic and bookmark completion provided in `href="…"` attributes. |
| `<MadCap:keyword>` | Dropped | Search index entries — invisible in the rendered preview. |
| `<MadCap:annotation>` | Unwrapped | Author comments are stripped, the inner content is preserved. |
| Other MadCap tags | Placeholder | Rendered as `[Unsupported MadCap:tagName]` and emit a structured warning. |

## Known limitations

- **Conditional expressions** are evaluated as a pragmatic subset of the Flare condition language: `include[…]` / `exclude[…]`, `or` / `and`, parentheses, top-level `AND`. Edge cases like `mc-conditional-text-skip-empty-paragraphs` are not modelled — the goal is "renders the topic the way the most-used target would," not byte-for-byte parity with a Flare build.
- **Flare proxies** (breadcrumbs, TOC, glossary, mini-TOC, relationships) are not rendered.
- **Master pages and skins** are not applied.
- **Auto-numbering counters** (`{chapnum}`, `{Gn+}`, etc. inside `mc-auto-number-format`) are stripped because the extension has no Flare build context to evaluate them. Static label text (NOTE/TIP/WARNING etc.) renders correctly.
- **The HTML sanitizer is regex-based** — adequate for trusted Flare topic content from your own project, but not a replacement for a real DOM sanitizer if you ever feed it untrusted HTML.

## Requirements

- VS Code 1.95 or later
- A folder containing a `.flprj` file (the extension activates automatically when one is detected, or when any HTML file is opened)

## Getting Started

1. Install the toolkit from the VS Code Marketplace.
2. Open the folder containing your Flare project's `.flprj` file.
3. Open any `.htm` topic. Variable inlay hints appear immediately; the link validator populates the Problems panel.
4. Click the **Live Preview** icon in the editor title bar (or run **Flare Toolkit: Live Preview** from the Command Palette) to open the rendered topic in a side panel.
5. As you type, the preview refreshes automatically. Save to force an immediate refresh.

## Walkthroughs

Step-by-step recipes for the workflows the toolkit is designed to make pleasant. Each starts from "I have a Flare topic open in VS Code" and ends with the change saved.

### Insert a cross-reference

Goal: link the cursor position in your prose to another topic in the project.

1. Place the cursor where the link should appear.
2. Open the Command Palette (`Ctrl/Cmd+Shift+P`) and run **Flare Toolkit: Insert Cross-Reference**.
3. Pick the target topic from the project-wide quick pick. Topics are listed by their first `<h1>`; type to filter.
4. Pick a bookmark from the second quick pick (or `(top of topic)` to link to the file itself). Bookmarks come from `<MadCap:anchor>` and `id="…"` attributes scanned from the target.
5. The toolkit inserts `<MadCap:xref href="…">link text</MadCap:xref>` at the cursor with the link text preselected so you can edit it without moving the cursor.

Faster path: type `<a href="` or `<MadCap:xref href="` directly. The cross-reference completion provider lists every project topic; after picking one, type `#` to list its bookmarks.

### Edit conditional text

Goal: hide a paragraph from the next public build without removing it from the source.

1. Make sure the project has at least one `.flcts` file under `Project/ConditionTagSets/`. If you need a new condition, add a `<ConditionTag Name="…" BackgroundColor="…" />` line there. The toolkit picks the change up the next time you save.
2. In the topic, add `MadCap:conditions="Default.Internal"` to the element you want to gate (substitute your own set and tag).
3. Start typing inside the quotes — the condition autocomplete lists every qualified `Set.Tag` discovered from your project's `.flcts` files. Description and color are shown in the docs panel.
4. Save. A colored square appears in the gutter next to the line, taking its color from the matching tag definition. Lines with mismatched or unknown tags get a neutral grey square plus a warning in the Problems panel.

To verify what each build target will see, use the target picker (next walkthrough).

### Pick a preview target

Goal: preview a topic exactly the way a specific build target would render it.

1. Open the topic and run **Flare Toolkit: Live Preview** (or click the **Live Preview** icon in the editor title bar).
2. In the preview header, find the **Target:** label and click **Change…**.
3. Pick a target from the quick pick. The list always includes a synthetic *Show everything* (the default — hides nothing) and *(Project default)* (uses the `PreviewConditionalExpression` from your `.flprj`), followed by every real `.fltar` file in `Project/Targets/`.
4. The preview re-renders. Elements gated by `MadCap:conditions=` are hidden if the picked target's expression excludes their tag list. The Conditions section in the preview tells you how many elements were hidden.
5. The choice persists per project root in `.vscode/flare-preview.json`, so the next time you open the preview from this workspace it remembers what you picked.

### Rename a condition tag everywhere

Goal: rename `Default.Beta` to `Default.Released` across the entire project — including the source `.flcts` file, every topic that gates content on it, every target that includes/excludes it, and the project's preview expression.

1. Run **Flare Toolkit: Rename Condition Tag…** from the Command Palette. (If your cursor is on a qualified `Set.Tag` token in a topic, that tag is preselected at the top of the picker.)
2. Pick the tag to rename from the project-wide quick pick.
3. Type the new tag name when prompted. The set name (the part before the dot) cannot change — Flare derives it from the `.flcts` filename.
4. The toolkit scans every `.flcts`, `.htm`/`.html`, `.fltar`, `.flprj`, and other `.fl*` file in the project for occurrences of the qualified name plus the source `<ConditionTag Name="…" />` element in the matching `.flcts`.
5. Review the multi-select quick pick — every found occurrence is pre-checked with a `before → after` preview. Uncheck anything you want to leave alone, then press Enter.
6. The toolkit applies a single `WorkspaceEdit`, which means the whole rename is one undo step. The information notification at the end tells you how many occurrences were updated across how many files.

### Rename a topic file and update every reference

Goal: rename `Content/Topics/old-name.htm` to `Content/Topics/new-name.htm` without leaving any broken links.

1. In the VS Code Explorer, press **F2** on the topic file (or right-click → Rename) and type the new name.
2. The toolkit notices the rename, scans every Flare-readable file in the project for references that point at the old path, and pops a multi-select quick pick listing each one with a `before → after` preview.
3. Uncheck anything you want to leave alone, then press Enter.
4. The toolkit applies a single `WorkspaceEdit`. Project-root-relative refs (`/Content/Topics/old-name.htm`) stay project-root-relative; sibling-relative refs (`../old-name.htm`) stay relative.

If the rename happened outside VS Code (terminal `mv`, file manager, `git mv`), run **Flare Toolkit: Find Stale References** instead. It scans the same files and surfaces every stale reference in the Problems panel so you can fix them by hand.

### Scaffold a cross-reference from selected text

Goal: turn the words "API reference" in your prose into a clickable link to the API topic without retyping them.

1. Select the text you want to become the link.
2. Click the lightbulb that appears (or press `Ctrl/Cmd+.`) and choose **Convert to cross-reference…**.
3. Pick the target topic from the project-wide quick pick (and a bookmark, if the topic has any).
4. The toolkit replaces your selection with `<MadCap:xref href="…">API reference</MadCap:xref>` — same href format as the regular Insert command, but the link text is whatever you originally selected.

Faster path: in the middle of writing prose, type `[[`. The completion popup opens the same topic picker; accepting an item erases the `[[` and inserts the full `<MadCap:xref>` tag, with the topic's `<h1>` prefilled as the link text.

### Insert an existing snippet into a topic

Goal: drop a `<MadCap:snippetBlock>` reference to an existing `.flsnp` file at the cursor, without retyping the path.

The toolkit gives you four equivalent entry points — pick whichever feels natural in the moment:

1. **Command palette / context menu.** Run **Flare Toolkit: Insert Snippet** (also available in the right-click menu inside any `.htm`/`.html` file). A project-wide quick pick lists every `.flsnp` under the project root, indexed by name, relative path, and a one-line preview of the snippet body. Type to filter — matches against any of the three. Pick one and the toolkit inserts `<MadCap:snippetBlock src="…" />` at the cursor with a forward-slash relative path computed from the active topic.
2. **`{{` trigger in prose.** Type two left braces (`{{`) anywhere in flowing prose. IntelliSense opens the same project-wide snippet list. Picking an item erases the `{{` and inserts the full `<MadCap:snippetBlock>` tag, with the snippet name and folder shown in the picker. Sibling to the `[[` cross-reference picker — same shape, different prefix.
3. **Tag attribute completion.** Type `<MadCap:snippetBlock src="` (or `<MadCap:snippet src="`, or `<MadCap:snippetText src="`) and IntelliSense lists every project snippet ranked by path. The body preview shows in the docs panel so you can see what each snippet contains before picking.
4. **Tag-scaffolding keyword.** In an empty spot, type `snipblock` (block-level) or `snip` (inline) and IntelliSense expands it to `<MadCap:snippetBlock src="$1" />` or `<MadCap:snippet src="$1" />` with the cursor parked inside the `src` attribute, ready for entry point #3 above.

All four routes resolve to the same XML — they're alternative entry points so you don't have to remember which one is "the" way to insert a snippet.

### Extract repeated prose into a new snippet

Goal: turn a paragraph you keep retyping into a `.flsnp` file in one step, without leaving the editor.

1. Select the prose you want to lift out. The toolkit accepts any selection that contains balanced markup (or no markup at all) — selections that cut through a tag are rejected so the parent topic stays well-formed.
2. Click the lightbulb (or press `Ctrl/Cmd+.`) and choose **Extract selection as snippet…**.
3. Enter a snippet name when prompted. The toolkit normalizes the input into a kebab-case slug (`installation prereqs` → `installation-prereqs`) and rejects empty / reserved / unsafe names with an inline validation error.
4. Pick a destination folder. The list shows the project's snippets root (`Content/Resources/Snippets`) plus every existing subfolder under it, plus a **Create new subfolder…** option for fresh organization.
5. The toolkit applies a single `WorkspaceEdit`: it creates `Content/Resources/Snippets/<folder>/<name>.flsnp` with the canonical Flare skeleton (`<?xml…?>` + `<html xmlns:MadCap="…">` + `<body>` containing your selection, with the leading indentation stripped), and replaces your original selection with `<MadCap:snippetBlock src="…" />` (or `<MadCap:snippet src="…" />` for inline selections). The whole rewrite is one undo step.
6. The new `.flsnp` file opens in a side editor for review.

If a file with the same name already exists in the chosen folder, the toolkit asks before overwriting — never silently clobbers.

### Add a condition to an existing element

Goal: gate a paragraph you already wrote on a `Default.Internal` build flag, without typing the attribute by hand.

1. Place the cursor anywhere inside the opening tag of the element you want to gate (e.g. inside `<p class="warn">`).
2. Click the lightbulb (or press `Ctrl/Cmd+.`) and choose **Add condition…**.
3. The toolkit pops a multi-select quick pick listing every condition tag in the project, with any tags already on this element pre-checked. Color swatches make the tags visually distinct.
4. Pick one or more tags and press Enter. The toolkit either inserts `MadCap:conditions="Default.Internal"` on the tag, or — if the element already had the attribute — appends to its existing value, deduplicating along the way.

Faster path: type `MadCap:` inside the opening tag and the attribute-name completion offers `MadCap:conditions=""`. Accepting it lands the cursor between the quotes and immediately retriggers IntelliSense so you can pick the tag value without an extra keystroke.

### Validate every topic before pushing

Goal: catch every broken link, missing snippet, missing image, missing stylesheet, and unknown condition tag in the project before opening a PR.

1. Run **Flare Toolkit: Validate All Topics** from the Command Palette.
2. A cancellable progress notification appears in the status bar. The toolkit walks every `.htm` / `.html` topic under the project root, runs the same link validator that powers the per-topic Problems panel diagnostics, and aggregates the results.
3. When it finishes, the Problems panel contains every broken local reference: missing files as errors, missing anchors as warnings, case-sensitivity drift as information notices.
4. External URLs (`http(s)://`, `mailto:`, `tel:`, `data:`) are skipped — the validator never makes network requests.

## Roadmap

Phases 1–10 are complete. Phase 10 added the `[[` topic picker, the **Convert selection to cross-reference** code action, the `xref` / `cond` / `cblock` snippet completions, condition attribute-name completion with retrigger, color swatches in the condition value picker, and the **Add condition…** code action. Remaining items rolled forward:

- **Class autocomplete** from project stylesheets.

Track progress in [`.project-plan.md`](.project-plan.md).

## Issues and feedback

Bug reports, feature requests, and validation results from your own Flare projects are very welcome at [github.com/docguytraining/mc-flare-vs-code-preview/issues](https://github.com/docguytraining/mc-flare-vs-code-preview/issues).

**Please do not contact MadCap Software for support with this toolkit.** This is an independent project — issues and questions should come here instead.

## Trademarks and disclaimer

This toolkit is an independent open-source project. It is not affiliated with, sponsored by, or endorsed by MadCap Software, Inc.

MadCap™ and MadCap Flare™ are trademarks of MadCap Software, Inc. and are used in this project only to identify the file format and authoring tool that this toolkit is designed to complement. This toolkit does not include or distribute any MadCap software, source code, or proprietary file format definitions.

Use of this toolkit requires a valid MadCap Flare license. This project does not provide a way to author Flare topics, manage Flare projects, build Flare outputs, or otherwise replace any function of MadCap Flare itself.

## License

MIT. See [LICENSE](LICENSE). Copyright © 2026 DocGuy Training.
