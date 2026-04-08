/**
 * Converts MadCap Flare proprietary CSS properties into standard CSS so they
 * render in the webview preview the way Flare's own compiler would render
 * them in a published build.
 *
 * Today this only handles `mc-auto-number-format`, which is the property that
 * powers all the NOTE/TIP/WARNING/IMPORTANT/CAUTION/EXAMPLE/etc. admonition
 * labels in real Flare projects. The source CSS looks like:
 *
 *   div.Note p.Head { mc-auto-number-format: "{b}NOTE  {/b}"; }
 *
 * Flare's compiler emits an equivalent `:before { content: …; }` rule for
 * the same selector at build time. We do the same here so the labels appear
 * in the preview without authors having to wait for a Flare build.
 *
 * The transform is intentionally textual / regex-based: a real CSS parser
 * would be more correct but is overkill for this single property family.
 * Anything we don't recognize is left alone.
 */

export interface FlareCssTransformResult {
  css: string;
  generatedRuleCount: number;
}

const AUTONUM_RULE_REGEX = /([^{}]+)\{([^{}]*?)mc-auto-number-format\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*)\3\s*;?([^{}]*)\}/g;

export function transformFlareCss(css: string): FlareCssTransformResult {
  let generatedRuleCount = 0;
  const transformed = css.replace(
    AUTONUM_RULE_REGEX,
    (_full, selector: string, before: string, _quote: string, formatValue: string, after: string) => {
      const cleanedSelector = selector.trim();
      if (cleanedSelector.length === 0) {
        return _full;
      }

      const { content, isBold, isItalic } = parseAutonumFormat(formatValue);
      // Strip the unknown `mc-auto-number-format` declaration from the
      // original rule but preserve every other property so existing styling
      // (border, padding, etc.) stays intact.
      const remainingDeclarations = `${before}${after}`
        .split(";")
        .map((decl) => decl.trim())
        .filter((decl) => decl.length > 0)
        .join("; ");
      const baseRule = remainingDeclarations.length > 0
        ? `${cleanedSelector} { ${remainingDeclarations}; }`
        : "";

      // Build the `:before` companion rule. We append `:before` to the LAST
      // simple selector in each comma-separated branch so a selector like
      // `div.Note p.Head` becomes `div.Note p.Head:before` (not
      // `div.Note p.Head :before`).
      const beforeSelector = appendBeforeToSelector(cleanedSelector);
      const cssContent = escapeCssString(content);
      const fontWeight = isBold ? " font-weight: bold;" : "";
      const fontStyle = isItalic ? " font-style: italic;" : "";
      const beforeRule = `${beforeSelector} { content: "${cssContent}";${fontWeight}${fontStyle} }`;
      generatedRuleCount += 1;
      return `${baseRule}\n${beforeRule}`;
    }
  );

  return { css: transformed, generatedRuleCount };
}

interface AutonumParseResult {
  content: string;
  isBold: boolean;
  isItalic: boolean;
}

/**
 * Strips Flare's autonum format markers and returns the literal content the
 * `:before` pseudo-element should display. The format language has several
 * features we can't faithfully render:
 *
 *   - Group prefixes like `GF:`, `GH:`, `GC:`, `GX:` scope numbering across
 *     a project; we drop them.
 *   - Counter tokens like `{chapnum}`, `{n+}`, `{Gn+}`, `{A+}`, `{ =0}`
 *     reference the live numbering state of a Flare build. We have no build
 *     state, so we drop them rather than display the raw token text.
 *   - `{family …}{/family}` and `{color …}{/color}` wrappers carry styling
 *     we can't easily map to a single pseudo-element; we strip the markers
 *     and keep the inner text.
 *   - `{b}…{/b}` / `{i}…{/i}` / `{u}…{/u}` marker pairs are stripped, and
 *     when the entire string is wrapped in a single one we record it so the
 *     generated rule can apply `font-weight`/`font-style`.
 *
 * The fallback target is admonition labels (NOTE, TIP, WARNING, IMPORTANT,
 * CAUTION, EXAMPLE, …), which is what real Flare projects use this property
 * for the vast majority of the time and which our pipeline now renders
 * correctly.
 */
function parseAutonumFormat(value: string): AutonumParseResult {
  let working = value;

  // Decode the small set of HTML entities Flare emits in autonum strings.
  working = working
    .replace(/&#160;|&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");

  let isBold = false;
  let isItalic = false;

  const wholeBold = /^\s*\{b\}([\s\S]*?)\{\/b\}\s*$/i.exec(working);
  if (wholeBold) {
    isBold = true;
    working = wholeBold[1];
  }

  const wholeItalic = /^\s*\{i\}([\s\S]*?)\{\/i\}\s*$/i.exec(working);
  if (wholeItalic) {
    isItalic = true;
    working = wholeItalic[1];
  }

  // Drop a leading group-prefix like `GF:`, `GH:`, `GC:`, `GX:`. These are
  // numbering-scope markers, not display content.
  working = working.replace(/^[A-Z]{1,3}:\s*/, "");

  // Drop wrapper markers (family, color, …) but keep the inner content.
  working = working.replace(/\{(?:family|color)\b[^}]*\}/gi, "");
  working = working.replace(/\{\/(?:family|color)\}/gi, "");

  // Drop remaining inline formatting markers ({b}, {i}, {u}).
  working = working.replace(/\{\/?[biu]\}/gi, "");

  // Drop counter tokens. These are runtime values we can't compute without a
  // Flare build context. Patterns we've seen in the wild include:
  //   {chapnum}, {n+}, {n}, {Gn+}, {A+}, {a+}, {A}, {n=1}, { =0}
  working = working.replace(/\{\s*[A-Za-z]*[+=]?\s*[0-9]*\s*\}/g, "");

  // Collapse 3-or-more space/tab runs introduced by the substitutions back to
  // a single space. We deliberately leave 2-space runs alone: Flare authors
  // commonly write labels like `"{b}NOTE  {/b}"` with two trailing spaces to
  // visually separate the label from the body text in the rendered :before,
  // and that intent should survive the transform.
  working = working.replace(/[ \t]{3,}/g, " ");

  return { content: working, isBold, isItalic };
}

function appendBeforeToSelector(selector: string): string {
  return selector
    .split(",")
    .map((branch) => `${branch.trim()}:before`)
    .join(", ");
}

function escapeCssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\A ");
}
