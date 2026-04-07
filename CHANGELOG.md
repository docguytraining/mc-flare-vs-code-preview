# Changelog

All notable changes to the MadCap Flare Preview extension are documented here.

## [0.1.1] — 2026-04-07

### Changed (rebranding)
- **Display name** updated from "MadCap Flare Preview" to **"Toolkit for MadCap Flare"** to clarify this is an unofficial third-party project for *editing* existing Flare topic files, not a Flare replacement.
- **Marketplace description** rewritten to lead with "Unofficial", to state that a MadCap Flare license is required, and to include the "Not affiliated with MadCap Software, Inc." disclaimer in the same sentence.
- **Editor title bar button** now uses an icon (`$(open-preview)`) with a "Live Preview" hover label instead of branded button text.
- **Command palette commands** are now grouped under the **Flare Toolkit** category. Renamed:
  - `Flare Preview` → `Flare Toolkit: Live Preview`
  - `Flare: Insert Cross-Reference` → `Flare Toolkit: Insert Cross-Reference`
- **Settings page heading** updated from "MadCap Flare Preview" to "Toolkit for MadCap Flare".
- **README** rewritten with a new hero, a "Why this extension exists" section that emphasizes complement-not-replacement, and a dedicated **Trademarks and disclaimer** section explaining that the project is independent and that MadCap™ and MadCap Flare™ are trademarks of MadCap Software, Inc.

### Fixed
- Settings description for `flarePreview.suggestionIgnoreVariables` no longer references the old inline `<!-- flare:no-suggest -->` comment mechanism (removed in 0.1.0). The description now points authors at the "Never suggest X in this topic" code action, which writes to `.vscode/flare-preview.json` without modifying the topic file.

### Notes
- Command IDs (`flare.*`) and setting IDs (`flarePreview.*`) are intentionally **unchanged** so existing configurations and keybindings continue to work. These identifiers are descriptive (referencing the file format), not brand-claiming.

## [0.1.0] — Initial public release

First Marketplace release. Eight implementation phases, validated end-to-end against a real Flare documentation project (~2,300 topics, 13 variable files, 561 unique variables).

### Preview rendering
- Project discovery via the nearest `.flprj`. Walks up from the active topic, caches per project root, skips macOS `._*` AppleDouble files, treats leading-`/` paths in `.flprj` references as project-root-relative (not filesystem-absolute), strips UTF-8 BOMs from XML reads.
- Variable resolution that recursively scans `Project/VariableSets/**/*.flvar`. Parses `<Variable>` element-text content as the canonical value (the format real Flare projects use), with fallback to `<Value>` child elements and `Value="…"` attributes. Stores each variable under both qualified (`Set.Name`) and bare (`Name`) keys so namespaced topic references resolve.
- Stylesheet aggregation that loads the master stylesheet referenced from `.flprj` plus auxiliary sheets under `Content/Resources/Stylesheets/` and `Content/Resources/TableStyles/`. `@import` rules are inlined.
- **Flare CSS translation**: converts `mc-auto-number-format` declarations into real `:before { content: …; font-weight: bold }` companion rules so NOTE/TIP/WARNING/IMPORTANT/CAUTION/EXAMPLE admonition labels appear in the preview without a Flare build. Group prefixes (`GH:`, `GF:`) and counter tokens (`{chapnum}`, `{Gn+}`) are stripped because the extension has no build context to evaluate them.
- MadCap transform pipeline:
  - `<MadCap:variable>` substitution
  - `<MadCap:conditionalBlock>` baseline suppression on `false`/`0`/`none`/`exclude`/`hide` keywords
  - `<MadCap:dropDown>` and `<MadCap:expandableArea>` rendered as native `<details>`/`<summary>`
  - `<MadCap:snippet>` and `<MadCap:snippetBlock>` resolution relative to topic and project root
  - `<MadCap:xref>` rendered as clickable links that open the target topic in the editor and reveal the bookmark anchor
  - `<MadCap:keyword>` dropped silently (search index entries, not visible content)
  - `<MadCap:annotation>` unwrapped while preserving inner content (previously the unsupported-tag fallback was erasing annotation bodies entirely)
  - Unknown MadCap tags rendered as `[Unsupported MadCap:tagName]` markers with structured warnings
- Render coordinator with three triggers: immediate save/dependency refresh, 800 ms debounced typing refresh, and a 10 s coalescing safeguard so rapid edits never starve the preview. Single in-flight render with stale cancellation.
- Webview rendered against an explicit white "sheet of paper" (`color-scheme: light`) so project stylesheets — designed for white browser backgrounds — render correctly regardless of the surrounding VS Code theme. Preview chrome (status bar, discovery summary, diagnostics) is scoped to `.flare-preview-*` selectors so generic `body`/`h1`/`p` rules in the project stylesheet can't override it. H2/H3 contrast is reinforced so brand-tinted headings stay legible.

### Authoring assistance
- **Variable inlay hints** that render the resolved value next to every `<MadCap:variable>` reference in the editor. Toggleable via `flarePreview.inlayHints.variables`.
- **Variable name completion** triggered inside `<MadCap:variable name="…">` attributes.
- **Value-prefix completion** that fires anywhere in flowing prose: type a word that begins a variable's value (case-sensitive) and the completion popup offers to replace the typed text with the canonical `<MadCap:variable name="…" />` reference. Multi-word matching with longest-match wins, so mid-paragraph typing works the same as start-of-paragraph.
- **Literal-to-variable suggestions**: case-sensitive scan finds prose literals that exactly match a known variable value. Each match is an Information diagnostic with three quick-fix actions: replace with the variable, dismiss for this topic, dismiss project-wide. Skips text inside existing MadCap tags, attributes, comments, and short/numeric/punctuation-only values.
- **Per-topic dismissal sidecar** at `<projectRoot>/.vscode/flare-preview.json`. Source-controllable, deterministic JSON, paths stored relative to the project root. The topic file itself is never modified by dismiss actions.
- **Automatic dismissal migration** on in-IDE topic renames via `vscode.workspace.onDidRenameFiles`. External renames (`git mv`, terminal `mv`) turn entries stale, which the activation-time scanner detects and surfaces as a warning notification with a "Show details" button that opens the output channel.
- **Project-wide dismissal** persisted to `flarePreview.suggestionIgnoreVariables` in workspace settings. Filters by underlying variable value so qualified and bare map entries are both suppressed in one action.
- **Insert Cross-Reference command** with a project-wide quick pick of every topic indexed by its first `<h1>` and a bookmark picker for the chosen topic. Uses the editor selection as the link text if one is active.
- **Cross-reference completion** for topic paths inside `<MadCap:xref>` / `<a>` `href` attributes, plus bookmark completion after a `#`.
- **Insert Cross-Reference** also wires the rendered xref click in the preview to open the target topic in the editor and reveal the anchor.

### Link validation
- Every open Flare topic is scanned for broken local references in `<MadCap:xref>`, `<a>`, `<img>`, `<link rel="stylesheet">`, `<MadCap:snippet>`, and `<MadCap:snippetBlock>`.
- Missing files surface as Problems-panel errors. Missing anchors as warnings. Case-sensitivity drift as Information notices (so case-sensitive Linux/CI environments don't surprise you later).
- External URLs (`http(s)://`, `mailto:`, `tel:`, `data:`) are skipped — the validator never makes network requests.
- Toggleable via `flarePreview.validateLinks`.

### Security and reliability
- Strict Content Security Policy with nonced scripts and workspace-scoped `localResourceRoots`.
- HTML sanitizer strips `<script>`, `<iframe>`, `<object>`/`<embed>`/`<applet>`, inline `<style>` blocks, meta refresh, inline event handlers (`onclick=`), `javascript:` URLs, and non-image `data:` URLs.
- CSS sanitizer blocks external `@import` and `url(http(s)://…)` references.
- Structured diagnostics (`DiagnosticCode`, severity, actionable hint) surfaced both in the preview panel and the **MadCap Flare Preview** output channel.
- Error boundaries around each pipeline stage (project resolution, variable resolution, stylesheet resolution, MadCap transform) with an escaped-source fallback render so a single failure doesn't break the preview entirely.

### Tests and tooling
- Sample Flare project fixture (`test/fixtures/sample-project/`) used by an end-to-end mocha suite that exercises every layer.
- Unit suites for the render coordinator, HTML sanitizer, CSS Flare-to-standard transformer, MadCap transform pipeline, topic index, link validator, variable suggestion engine, dismissal store, and value-prefix completion provider.
- `.vscode/launch.json` with two configurations (`Run Extension`, `Run Extension on TPP Project`) and a `tasks.json` build task so contributors can press F5 and immediately validate against a real Flare project.
- Marketplace metadata: publisher, repository, bugs, homepage, categories, keywords. `.vscodeignore` excludes tests, fixtures, source, and the project plan from the published VSIX.
