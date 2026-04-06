# Changelog

All notable changes to the MadCap Flare Preview extension will be documented in this file.

## [Unreleased]

### Added (Phase 7 — Authoring Assistance)
- `TopicIndex` that walks the nearest Flare project for every `.htm`/`.html` file and records the first `<h1>` and every bookmark (`id=`, `<a name>`, `<MadCap:anchor>`) with file-watcher invalidation.
- Variable inlay hints that render the resolved value next to `<MadCap:variable>` / `${token}` references, gated by `flarePreview.inlayHints.variables`.
- Variable completion provider triggered by `$` or inside `<MadCap:variable name="…">`.
- "Did you mean a Flare variable?" diagnostic + code action that replaces literal text matching a known variable value with the appropriate `<MadCap:variable>` or `${token}` reference, gated by `flarePreview.suggestVariableReplacements` and `flarePreview.variableReplacementMinLength`.
- `Flare: Insert Cross-Reference` command with a project-wide QuickPick of topics by H1 and a follow-up bookmark picker.
- Completion provider for `<MadCap:xref>` / `<a>` `href` attributes that suggests topic paths and bookmarks from the target topic.
- Link validator that populates the Problems panel with broken-link, anchor-missing, and case-drift diagnostics for every open Flare topic, gated by `flarePreview.validateLinks`.
- `<MadCap:xref>` is now rendered in the preview as a clickable link; clicking opens the target topic in the editor and reveals the anchor when present.
- Fixture additions (`Content/Topics/Installation.htm`) plus mocha suites for `TopicIndex`, the link validator, and the variable suggestion engine.

### Added
- Scaffolded TypeScript extension with `Flare: Preview HTML Topic` command, editor title bar action, Explorer context menu integration, and webview panel lifecycle.
- Flare project discovery: walks up from the active topic to locate the nearest `.flprj` and caches project context per root.
- Variable resolution from `.flvar` files with structured diagnostics for unresolved references.
- Stylesheet discovery from topic `<link>` tags and project `Stylesheets/` folders, with `@import` expansion.
- MadCap transform pipeline covering `<MadCap:variable>`, `<MadCap:conditionalBlock>`, `<MadCap:dropDown>`/`<MadCap:expandableArea>`, and `<MadCap:snippet>`/`<MadCap:snippetBlock>`, plus fallback markers for unsupported tags.
- Render coordinator with save/dependency refresh, 800 ms debounced typing refresh, single-in-flight renders, and a 10 s coalescing safeguard.
- Strict Content Security Policy with nonced scripts, workspace-scoped `localResourceRoots`, webview URI rewriting for local `img`/`href` targets, and HTML/CSS sanitizers that strip scripts, inline styles, event handlers, and external resource references.
- Structured diagnostics (code, severity, hint) surfaced in the preview panel and the `MadCap Flare Preview` output channel.
- Error boundaries around each pipeline stage with an escaped-source fallback render.
- Sample Flare project fixture used by integration tests, plus unit tests for the render coordinator, HTML sanitizer, MadCap transform pipeline, and end-to-end fixture pipeline.
