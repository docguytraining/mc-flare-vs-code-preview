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

### Conditional text and target picker

- **Condition tag set index** — every `.flcts` file under `Project/ConditionTagSets` is parsed and indexed by qualified `<setName>.<tagName>`. Color and comment metadata are surfaced in completion documentation.
- **Target-aware preview** — the transform pipeline parses `MadCap:conditions=` on every element and hides anything the active target's expression excludes. Supports `include[A or B]`, `exclude[A and B]`, nested grouping, and `AND` between top-level clauses.
- **Target picker** — a "Target" label and "Change…" button appear in the preview header. Picking a target persists per project root in `.vscode/flare-preview.json`. The list always includes a synthetic *Show everything* (default) and *(Project default)* entry.
- **Condition badges** *(opt-in)* — turn on `flarePreview.showConditionBadges` to inject a small `madcap-condition-badge` pill inside every conditional element so you can see at a glance which tag gates each block.
- **Condition autocomplete** — typing inside `MadCap:conditions="…"` or `MadCap:conditionTagExpression="…"` opens a completion list of every qualified condition tag in the project.
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

| Command | Palette title | Where |
|---|---|---|
| `flare.previewHtml` | **Flare Toolkit: Live Preview** | Editor title bar icon (`.htm` / `.html`), Command Palette, Explorer context menu |
| `flare.insertXref` | **Flare Toolkit: Insert Cross-Reference** | Command Palette, editor context menu |
| `flare.pickPreviewTarget` | **Flare Toolkit: Pick Preview Target** | Command Palette, "Change…" button in preview header |
| `flare.validateAllTopics` | **Flare Toolkit: Validate All Topics** | Command Palette |
| `flare.findStaleReferences` | **Flare Toolkit: Find Stale References** | Command Palette |

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

## Roadmap

Phases 1–9 are complete. Remaining items rolled forward:

- **Class autocomplete** from project stylesheets.
- **Inline gutter decorations** showing each `MadCap:conditions=` tag's color from the source `.flcts` file.
- **"Rename condition tag …" code action** that updates every reference across the project (uses the same engine as cross-project rename).
- **Clickable line-links** from each entry in the preview's Conditions section back to the source position in the editor.

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
