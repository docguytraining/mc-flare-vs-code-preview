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
