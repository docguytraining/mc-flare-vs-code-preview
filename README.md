# MadCap Flare VS Code Preview

Preview MadCap Flare topic files (`.htm` / `.html`) inside VS Code with Flare-aware rendering: variables are resolved, conditional blocks are applied, drop-down and expandable regions expand to native `<details>`, snippets are inlined, and project stylesheets are applied so the preview looks closer to what Flare's compiled output would produce than a generic HTML previewer.

## Features

- **Flare project discovery** — walks upward from the active topic to locate the nearest `.flprj` and caches the result per project root.
- **Variable resolution** — parses every `.flvar` referenced by the project and substitutes `<MadCap:variable>` and `${token}` references, with a diagnostic for every unresolved name.
- **Stylesheet aggregation** — collects topic-linked stylesheets, project-level stylesheets, and resolves `@import`/relative asset URLs in a deterministic order.
- **MadCap transform pipeline** — ordered handlers for variables, conditional blocks, drop-down/expandable regions, and snippet includes, with fallback markers for unsupported tags.
- **Webview preview** — strict Content Security Policy, nonced scripts, workspace-scoped `localResourceRoots`, webview URI rewriting for local `img`/`href` targets, and an HTML/CSS sanitizer that strips scripts, inline styles, event handlers, and external resource references.
- **Refresh engine** — immediate refresh on save or dependency change, 800 ms debounced typing refresh (configurable), single-in-flight renders with stale cancellation, and a 10 s coalescing safeguard so rapid edits never starve the preview.
- **Structured diagnostics** — every warning carries a code, severity, and actionable hint and is surfaced both in the preview panel and in the `MadCap Flare Preview` output channel.

## Commands

| Command ID | Title | Entry points |
| --- | --- | --- |
| `flare.previewHtml` | `Flare: Preview HTML Topic` | Command palette, editor title bar (`.htm`/`.html`), Explorer context menu |

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `flarePreview.autoRefreshOnSave` | `boolean` | `true` | Refresh the preview after saving an HTML topic or a dependency file (`.flprj`, `.flvar`, `.css`). |
| `flarePreview.typingDebounceMs` | `number` | `800` | Debounce delay for typing-driven preview refresh. Minimum 300 ms. |

## Supported MadCap tags

| Feature | Status | Notes |
| --- | --- | --- |
| `<MadCap:variable>` / `${token}` | Supported | Value sourced from project `.flvar` files. Unresolved names render a marker and warning. |
| `<MadCap:conditionalBlock>` | Supported (baseline) | Condition values of `false`, `0`, `none`, `exclude`, or `hide` suppress the block; everything else renders. Full include/exclude expression evaluation is not yet implemented. |
| `<MadCap:dropDown>` / `<MadCap:expandableArea>` | Supported | Converted to native `<details>`/`<summary>` using the hotspot text or the `title` attribute as the summary. |
| `<MadCap:snippet>` / `<MadCap:snippetBlock>` | Supported | Resolved relative to the topic first, then the project root. Missing snippets render an inline warning marker. |
| Unsupported MadCap tags | Placeholder | Unknown tags render as `[Unsupported MadCap:tagName]` markers and emit a structured warning instead of breaking the preview. |

### Known limitations

- No breadcrumb, TOC proxy, or other Flare proxy rendering.
- Conditional expressions only honor a small set of suppression keywords; include/exclude target sets are not yet modeled.
- WYSIWYG editing inside the preview is out of scope.
- Full Flare build simulation (master pages, skins, relationship tables) is not performed.
- The HTML sanitizer is regex-based — good enough for trusted topic content, but not a replacement for a DOM sanitizer if you render untrusted HTML.

## Requirements

- Node.js 20+
- npm 10+
- VS Code 1.95+

## Getting Started

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development Host. Open any `.htm` or `.html` topic and run `Flare: Preview HTML Topic` from the Command Palette (or click the preview button in the editor title bar).

## Scripts

- `npm run compile` — compile TypeScript to `out/`
- `npm run watch` — compile in watch mode
- `npm run lint` — run ESLint on TypeScript source
- `npm test` — run the extension test suite (unit + fixture integration tests)
- `npm run package` — build a `.vsix` package with `@vscode/vsce`

## Repository Structure

```text
.
|- media/                                  preview stylesheet and assets
|- src/
|  |- extension.ts                         activation, command wiring, diagnostics pipeline
|  |- core/                                project resolver, shared types, logger
|  |- flare/                               variable/stylesheet/transform pipeline
|  |- preview/                             webview panel and render coordinator
|  |- security/                            HTML + CSS sanitizers
|  |- test/suite/                          mocha test suites
|- test/fixtures/sample-project/           Flare project fixture used by integration tests
|- .project-plan.md                        phase checklist and verification notes
|- package.json
|- tsconfig.json
```

## Release Checklist

- [ ] `npm run lint` and `npm test` pass on a clean checkout
- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated with the release notes
- [ ] Marketplace assets (icon, screenshots) present
- [ ] `npm run package` produces a VSIX and installs cleanly in a fresh VS Code profile
- [ ] Smoke test against at least one real Flare project (variables, conditionals, snippets, stylesheets)
- [ ] Git tag created for the released version

## Roadmap

Phase-by-phase status lives in [`.project-plan.md`](.project-plan.md). Phases 1–6 (scaffold, discovery, transforms, preview interaction, security/diagnostics, validation and publish readiness) are complete.

## License

MIT. See [LICENSE](LICENSE).
