# MadCap Flare VS Code Preview

A VS Code extension project that previews MadCap Flare topic files (`.htm` and `.html`) with Flare-aware processing.

The goal is to render elements that standard HTML previewers skip because they are not part of the HTML spec (for example Flare variables and MadCap-specific tags).

## Current Status

This repository is in active development.

Phase 1 foundation is implemented:
- TypeScript VS Code extension scaffold
- `Flare: Preview HTML Topic` command
- Editor title and Explorer context menu integration for `.htm`/`.html`
- Preview webview panel lifecycle (open/reveal/dispose)
- Build/lint/test script setup

Flare-specific parsing and rendering logic is planned for subsequent phases.

## Planned Capability

- Detect nearest Flare project by locating `.flprj`
- Resolve Flare variables from project sources
- Locate and apply topic and project stylesheets
- Transform MadCap-supported elements for accurate preview
- Auto-refresh preview on save and dependency changes

## Repository Structure

```text
.
|- media/
|  |- preview.css
|- src/
|  |- extension.ts
|  |- preview/
|  |  |- previewPanel.ts
|  |- test/
|     |- runTest.ts
|     |- suite/
|        |- index.ts
|        |- extension.test.ts
|- .project-plan.md
|- package.json
|- tsconfig.json
```

## Requirements

- Node.js 20+
- npm 10+
- VS Code 1.95+

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run compile
```

3. Open the project in VS Code and start extension development:

- Press `F5` to launch an Extension Development Host.
- Open any `.htm` or `.html` file.
- Run `Flare: Preview HTML Topic` from the Command Palette.

## Scripts

- `npm run compile` - compile TypeScript to `out/`
- `npm run watch` - compile in watch mode
- `npm run lint` - run ESLint on TypeScript source
- `npm test` - run extension tests
- `npm run package` - build a `.vsix` package

## Publishing Notes

Before publishing to the VS Code Marketplace:
- Replace placeholder publisher metadata as needed.
- Add extension icon and screenshots.
- Finalize settings and supported MadCap feature matrix.
- Verify behavior against real Flare projects.

## Roadmap

Implementation is tracked in [`.project-plan.md`](.project-plan.md), including phase checklists and verification criteria.

## License

No license file is included yet. Add a license before public release.
