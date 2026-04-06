# Phase 8 Validation Findings

Validation against `~/gitlab/tppdocs/TPP Project` (the Venafi / CyberArk Trust Protection Platform docs project).

## Project shape

- **Single `.flprj`:** `MasterProject_Director.flprj` at the project root.
- **2,299 topics** under `Content/` (lots of nested feature folders: `ACME`, `AdminConsoles`, `Agent`, `Aperture`, `Certificates`, `CodeSigning`, ...).
- **13 variable sets** under `Project/VariableSets/*.flvar` (e.g. `_Variables-Generic.flvar`, `UI.flvar`, `CLI.flvar`, `SDK.flvar`, `HSM.flvar`, ...).
- **Source stylesheets** under `Content/Resources/Stylesheets/` — `VenafiMasterStyleSheet.css` is the master, plus `QuickStart-StyleSheet.css`, `StylesForHomePage.css`, `zz-review-stylesheet.css`, fontawesome, table styles.
- **Compiled output** lives under `Output/` — already excluded by `TopicIndex.SKIP_DIRECTORIES`. Good.
- **Snippets** under `Content/Resources/Snippets/<feature>/`.
- **AppleDouble files** (`._MasterProject_Director.flprj`, `._*.flvar`, etc.) sit alongside real files because the project lives on macOS.

## `.flprj` contents

```xml
<?xml version="1.0" encoding="utf-8"?>
<CatapultProject Version="1" SourceControlBound="false"
    MasterToc="/Project/TOCs/SideNav_Master.fltoc"
    MasterStylesheet="/Content/Resources/Stylesheets/VenafiMasterStyleSheet.css"
    MasterStylesheetOverride="True"
    PreviewConditionalExpression="exclude[Default.ContentDevOnly or Default.Deprecated or Default.Futured or HelpUI.TopNavFiles]">
    ...
</CatapultProject>
```

Two important pieces of information that our resolver does not yet act on:
1. `MasterStylesheet="/Content/Resources/Stylesheets/VenafiMasterStyleSheet.css"` — leading `/` means *project-root-relative*, not filesystem-absolute.
2. `PreviewConditionalExpression="exclude[...]"` — a default conditional expression that should be applied to every preview.

The `.flprj` does **not** enumerate the variable sets — they're discovered by convention from `Project/VariableSets/`.

## Sample variable file (`_Variables-Generic.flvar`)

```xml
<?xml version="1.0" encoding="utf-8"?>
<CatapultVariableSet>
  <Variable Name="Contact_PhoneNumber" OriginalName="Contact_PhoneNumber">801-676-6900</Variable>
  <Variable Name="trademark" Comment="...">™</Variable>
  <Variable Name="ProductName_VED_TM" EvaluatedDefinition="CyberArk Trust Protection Foundation™">CyberArk Trust Protection Foundation™</Variable>
  ...
</CatapultVariableSet>
```

Two patterns we don't currently handle:
- The variable value is the **element's text content**, not a `<Value>` child or `Value=` attribute. Our current parser will return empty values for every variable in this project.
- Some variables carry `EvaluatedDefinition="..."` — that's Flare's cached evaluation, not the source of truth. We should still use the inner text as the canonical value.

## Sample topic reference patterns

```xml
<MadCap:variable name="UI.Feature_BulkProvisioning" />
<MadCap:variable name="_Variables-Generic.ProductName_Aperture_TM" />
<MadCap:variable name="_Variables-Generic.WebAdmin" />
```

References are **namespaced** as `<filename-without-extension>.<variable-name>`. Our resolver builds a flat map keyed by the bare `Name` attribute, so even after the parser is fixed, these lookups will all miss.

Other tags seen in the wild:
- `<MadCap:keyword term="..." />` — search index entries; should render as nothing (currently surface as unsupported markers).
- `<MadCap:annotation MadCap:comment="..." MadCap:creator="..." ...>real content</MadCap:annotation>` — author comments wrapping real content; the wrapper should be dropped but the inner content kept (currently the whole thing is replaced with an unsupported marker, **erasing the body text**).
- `<MadCap:snippetBlock src="..." MadCap:conditionTagExpression="include[...]" />` — snippet inclusion gated by conditions; we ignore the expression and always include (acceptable degradation for v1).
- `<p MadCap:autonum="...">` — Flare auto-numbering on a paragraph attribute; cosmetic, no action needed.

## Findings (prioritized)

### Critical — variable resolution is completely broken on this project

| # | Severity | Component | Issue |
|---|---|---|---|
| 1 | Critical | `variableResolver.ts` | Parser only reads `<Value>` child / `Value=` attribute. Real Flare projects (and the file-format docs) use the element's text content. **Every variable in this project parses as empty.** |
| 2 | Critical | `variableResolver.ts` / `flareProjectResolver.ts` | Variable sets aren't enumerated in `.flprj`; the resolver currently only finds variables mentioned by filename in the `.flprj` text. Must (a) **recursively** scan `Project/VariableSets/**/*.flvar` so subfolders are covered, (b) keep honoring any `.flvar` paths referenced in the `.flprj` text so cross-project variable imports keep working, and (c) deduplicate. A flat one-directory listing is not enough — Flare authors organize variable sets into subfolders and import sets from sibling projects. |
| 3 | Critical | `variableResolver.ts` | References use `<setname>.<varname>` namespacing. The resolver builds a flat map keyed by bare `Name`, so namespaced references can never resolve. |

### High — preview rendering and resolver correctness

| # | Severity | Component | Issue |
|---|---|---|---|
| 4 | High | `flareProjectResolver.ts` | The resolver matches **any** `*.flprj` in the directory listing. macOS AppleDouble files (`._MasterProject_Director.flprj`) get picked up as a candidate, and on the wrong day will silently win. Needs to skip `._*` filenames. |
| 5 | High | `stylesheetResolver.ts` / `flareProjectResolver.ts` | `.flprj` references like `/Content/Resources/Stylesheets/VenafiMasterStyleSheet.css` are project-root-relative (leading `/`) but `path.resolve(projectRoot, "/Content/...")` interprets them as filesystem-absolute. The master stylesheet is silently lost. |
| 6 | High | `madcapTransformPipeline.ts` | `<MadCap:annotation>` is currently caught by the unsupported-tag fallback, which **erases its inner content**. The wrapper should be dropped while the body text is preserved. |
| 7 | High | `madcapTransformPipeline.ts` | `<MadCap:keyword>` clutters headings with `[Unsupported MadCap:keyword]` markers. It should render as nothing — it's a search index entry, not visible content. |

### Medium — accuracy gaps

| # | Severity | Component | Issue |
|---|---|---|---|
| 8 | Medium | `madcapTransformPipeline.ts` | Conditional expressions in the wild look like `exclude[Default.ContentDevOnly or Default.Deprecated]`, applied via `MadCap:conditions=` on blocks and via `PreviewConditionalExpression=` in the `.flprj`. Our handler only understands the keywords `false`/`0`/`none`/`exclude`/`hide`. Real expressions need a small parser. |
| 9 | Medium | `madcapTransformPipeline.ts` | `<MadCap:snippetBlock src="..." MadCap:conditionTagExpression="include[...]" />` is rendered unconditionally. Once #8 lands, snippet condition expressions can be honored using the same parser. |
| 10 | Medium | All XML parsers | Flare files are saved with a UTF-8 BOM. Our regex parsers tolerate it, but anything that does `JSON.parse` / strict-XML parsing in the future would need to strip it. Note for later. |

### Low — performance / polish

| # | Severity | Component | Issue |
|---|---|---|---|
| 11 | Low | `topicIndex.ts` | First scan reads 2,299 topic files from disk. Acceptable but should be measured; lazy/incremental scanning could help if it becomes noticeable. |
| 12 | Low | `linkValidator.ts` | Same — the validator runs per open document, but a project-wide "Validate All Topics" pass against this corpus needs to be measured. |

## Fix order proposal

The critical and high findings (#1–#7) all need to land before manual walkthrough is meaningful — without them, variable resolution returns nothing, the master stylesheet doesn't load, and several common tags either erase content or pollute the preview. I'll fix them in this order:

1. **Variable resolver** (#1, #2, #3) — element-text values, convention scan of `Project/VariableSets/`, namespace-prefixed lookups.
2. **Project resolver** (#4) — skip `._*` AppleDouble files.
3. **Path normalization** (#5) — treat leading-`/` references in `.flprj`/topic HTML as project-root-relative.
4. **Transform pipeline** (#6, #7) — drop `<MadCap:keyword>` silently, unwrap `<MadCap:annotation>` while preserving inner content.

Then the medium items (#8, #9 — conditional expression parsing) and the polish items (#10–#12) become Phase 8 follow-ups.

## Round 2 — surfaced while authoring against the real project

| # | Severity | Component | Issue | Resolution |
|---|---|---|---|---|
| 13 | High | `media/preview.css` / `previewPanel.ts` | The rendered topic was rendering against the dark VS Code editor background, but the project's stylesheet was designed for a white browser background. Body text was visually invisible. | `.topic-frame` is now an explicit "white sheet of paper" with `color-scheme: light`, and all preview chrome rules are scoped to `.flare-preview-*` so generic `body`/`h1`/`p` selectors in the project stylesheet can't override them. |
| 14 | High | `stylesheetResolver.ts` | Only the master stylesheet referenced from `.flprj` was being loaded. Auxiliary stylesheets in `Content/Resources/Stylesheets/` and `Content/Resources/TableStyles/` were missed. | The resolver now also walks `Content/Resources/Stylesheets/**/*.css` and `Content/Resources/TableStyles/**/*.css` by convention. |
| 15 | High | `flareCssTransform.ts` *(new)* | Flare's `mc-auto-number-format` property powers every NOTE/TIP/WARNING/IMPORTANT/CAUTION/EXAMPLE label in the project. Browsers don't understand this property, so the labels disappeared entirely. | New CSS pre-processing pass converts each `mc-auto-number-format` declaration into a real `:before { content: …; font-weight: bold; }` companion rule for the same selector. Group prefixes (`GH:`/`GF:`/`GC:`/`GX:`) and counter tokens (`{chapnum}`, `{Gn+}`, …) are stripped because we have no Flare build context to evaluate them. |
| 16 | Medium | `variableResolver.ts` / `madcapTransformPipeline.ts` / `variableInlayHintsProvider.ts` / `variableCompletionProvider.ts` / `variableSuggestionEngine.ts` | The `${VariableName}` shorthand wasn't part of Flare's syntax — it was a convenience I introduced before validating against a real project. It produced false-positive completions on `$` and offered a non-Flare quick-fix. | Removed across the entire codebase. The pipeline now only handles `<MadCap:variable>` references. |
| 17 | Medium | `variableSuggestionEngine.ts` | Case-insensitive matching produced noisy false positives — generic English words like "user" or "page" matched variables that happened to share their lowercase form. | Switched to case-sensitive matching against the trimmed variable value. Authors who type "Trust Pro" still get a suggestion for `Trust Protection Foundation`, but generic prose stops triggering. |
| 18 | Medium | `variableSuggestionEngine.ts` / `variableCompletionProvider.ts` | A project-wide ignore list is too coarse — some topics legitimately want a literal that elsewhere should be a variable. | Per-topic dismissal via inline `<!-- flare:no-suggest VariableName -->` comments, inserted automatically by a new code action. Lives in the file, source-controlled, reviewable. The project-wide `flarePreview.suggestionIgnoreVariables` workspace setting is still available for variables that are always noisy. The two ignore lists are unioned at refresh time, and both are honored by the value-prefix completion provider. |
| 19 | New feature | `variableCompletionProvider.ts` | Authors had to type a literal first, wait for the diagnostic squiggle, and then accept the lightbulb fix. | New value-prefix completion mode: while typing prose, completions appear for any variable whose value (case-sensitive) starts with the typed prefix. Accepting one replaces the typed prefix with the canonical `<MadCap:variable name="…" />` reference in a single edit. |
| 20 | Polish | `package.json` | The explicit `activationEvents` for `onLanguage:html` and `onCommand:flare.previewHtml` were redundant on VS Code 1.74+, which auto-generates them from contribution declarations. | Removed. |
| 21 | Dev infra | `.vscode/launch.json` + `.vscode/tasks.json` *(new)* | Pressing F5 in the extension repo did nothing useful — there was no launch config. | Added "Run Extension" and "Run Extension on TPP Project" launch configurations and the `npm: compile` build task they depend on, so contributors can press F5 and immediately validate against a real Flare project. |
