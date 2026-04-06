# Changelog

All notable changes to the MadCap Flare Preview extension will be documented in this file.

## [Unreleased]

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
