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

## Supported MadCap tags

| Tag | Status | Notes |
|---|---|---|
| `<MadCap:variable>` | Supported | Resolved against project `.flvar` files. Both qualified (`Set.Name`) and bare (`Name`) references. |
| `<MadCap:conditionalBlock>` | Baseline | Suppresses on `false` / `0` / `none` / `exclude` / `hide`; everything else renders. Full include/exclude expression evaluation is on the Phase 9 roadmap. |
| `<MadCap:dropDown>` / `<MadCap:expandableArea>` | Supported | Rendered as native `<details>` / `<summary>` using the hotspot text or `title` attribute. |
| `<MadCap:snippet>` / `<MadCap:snippetBlock>` | Supported | Resolved relative to the topic first, then the project root. Missing snippets render an inline warning marker. |
| `<MadCap:xref>` | Supported | Rendered as a clickable link that opens the target in the editor. Topic and bookmark completion provided in `href="…"` attributes. |
| `<MadCap:keyword>` | Dropped | Search index entries — invisible in the rendered preview. |
| `<MadCap:annotation>` | Unwrapped | Author comments are stripped, the inner content is preserved. |
| Other MadCap tags | Placeholder | Rendered as `[Unsupported MadCap:tagName]` and emit a structured warning. |

## Known limitations

- **Conditional expressions** are evaluated against a small keyword set, not against the full Flare condition language. Real `include[A or B]` / `exclude[…]` semantics, target-specific previews, and a target picker are scoped for Phase 9.
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

Phases 1–8 are complete. Phase 9 (in scoping) covers:

- Condition tag set discovery and a target picker dropdown for the preview, so you can render the topic as a specific Flare target would build it.
- Conditional text completion and validation in topic-level `MadCap:conditions=` attributes.
- Snippet condition display in the preview metadata, with element/snippet condition counts.
- Cross-project rename references — when you rename or move a topic in VS Code, the extension scans every other topic in the project for incoming xref/href/snippet references and offers to update them in one batch.
- Class autocomplete from project stylesheets.

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
