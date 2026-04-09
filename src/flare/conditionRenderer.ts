import {
  ConditionExpression,
  alwaysRender,
  parseConditionsAttribute,
  shouldRenderForTags
} from "./conditionExpression";

/**
 * Result of one pass over the topic HTML for condition handling. Hidden
 * elements are stripped from `html`; everything else is preserved verbatim
 * apart from the optional badge insertion described in {@link applyConditions}.
 *
 * The two `*Counts` maps power the discovery summary in the preview status
 * area: each unique element-level `MadCap:conditions=` value (and each unique
 * snippet `MadCap:conditionTagExpression=` value) is recorded along with how
 * many times it appears in the topic. Counts are computed against the input
 * HTML before any hiding so authors see the conditions even when the active
 * target would suppress them.
 */
export interface ConditionRenderResult {
  html: string;
  hiddenCount: number;
  elementConditionCounts: Map<string, number>;
  snippetConditionCounts: Map<string, number>;
}

export interface ApplyConditionsOptions {
  expression?: ConditionExpression;
  showBadges?: boolean;
  /** Maps qualified condition tag names (e.g. "Default.PrintOnly") to their
   *  hex background colors from the project's .flcts files. Used to tint the
   *  pill badge with the author's chosen swatch while keeping text legible. */
  conditionColors?: Map<string, string>;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

const CONDITIONS_ATTR_REGEX = /\sMadCap:conditions\s*=\s*(["'])([^"']*)\1/i;
const CONDITION_EXPRESSION_ATTR_REGEX =
  /\sMadCap:conditionTagExpression\s*=\s*(["'])([^"']*)\1/i;
const TAG_NAME_REGEX = /^<\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/;

/**
 * Walks the topic HTML and applies the active target's condition expression
 * to every element carrying a `MadCap:conditions=` attribute. Snippet includes
 * are handled separately by the snippet handler — this function only
 * inventories their `MadCap:conditionTagExpression=` values for the discovery
 * summary.
 */
export function applyConditions(
  html: string,
  options: ApplyConditionsOptions = {}
): ConditionRenderResult {
  const expression = options.expression ?? alwaysRender();
  const showBadges = options.showBadges ?? false;
  const conditionColors = options.conditionColors;

  const elementConditionCounts = new Map<string, number>();
  const snippetConditionCounts = new Map<string, number>();
  let hiddenCount = 0;
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, tagStart);

    // Skip comments, CDATA, and processing instructions verbatim.
    if (html.startsWith("<!--", tagStart)) {
      const end = html.indexOf("-->", tagStart + 4);
      const stop = end === -1 ? html.length : end + 3;
      output += html.slice(tagStart, stop);
      cursor = stop;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const end = html.indexOf("]]>", tagStart + 9);
      const stop = end === -1 ? html.length : end + 3;
      output += html.slice(tagStart, stop);
      cursor = stop;
      continue;
    }
    if (html.startsWith("<?", tagStart) || html.startsWith("<!", tagStart)) {
      const end = html.indexOf(">", tagStart + 2);
      const stop = end === -1 ? html.length : end + 1;
      output += html.slice(tagStart, stop);
      cursor = stop;
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd === -1) {
      output += html.slice(tagStart);
      break;
    }
    const tagText = html.slice(tagStart, tagEnd + 1);
    const nameMatch = TAG_NAME_REGEX.exec(tagText);
    if (!nameMatch) {
      output += tagText;
      cursor = tagEnd + 1;
      continue;
    }
    const tagName = nameMatch[1];
    const lowerName = tagName.toLowerCase();
    const isClose = tagText.startsWith("</");
    const isSelfClosing =
      tagText.endsWith("/>") || (!isClose && VOID_ELEMENTS.has(lowerName));

    if (isClose) {
      output += tagText;
      cursor = tagEnd + 1;
      continue;
    }

    // Inventory snippet condition expressions.
    if (lowerName === "madcap:snippet" || lowerName === "madcap:snippetblock") {
      const match = CONDITION_EXPRESSION_ATTR_REGEX.exec(tagText);
      if (match) {
        bumpCount(snippetConditionCounts, match[2]);
      }
    }

    const conditionsMatch = CONDITIONS_ATTR_REGEX.exec(tagText);
    if (!conditionsMatch) {
      output += tagText;
      cursor = tagEnd + 1;
      continue;
    }

    const rawConditionList = conditionsMatch[2];
    bumpCount(elementConditionCounts, rawConditionList);

    // Flare topics occasionally use magic literals (`false`, `0`, `none`,
    // `exclude`, `hide`) instead of a real condition tag list to force-hide
    // a block at preview time. The downstream legacy `replaceConditionalBlocks`
    // handler used to recognize these, but it never sees them now that
    // `applyConditions` strips the conditions attribute first. Centralize the
    // check here so both code paths agree.
    const trimmedRaw = rawConditionList.trim().toLowerCase();
    const isMagicDisabled =
      trimmedRaw === "false" ||
      trimmedRaw === "0" ||
      trimmedRaw === "none" ||
      trimmedRaw === "exclude" ||
      trimmedRaw === "hide";

    const tagList = parseConditionsAttribute(rawConditionList);
    const shouldRender = !isMagicDisabled && shouldRenderForTags(expression, tagList);

    if (!shouldRender) {
      hiddenCount += 1;
      if (isSelfClosing) {
        cursor = tagEnd + 1;
        continue;
      }
      // Skip this element and everything inside it up to the matching close.
      const skipEnd = findMatchingCloseTag(html, tagName, tagEnd + 1);
      cursor = skipEnd === -1 ? html.length : skipEnd;
      continue;
    }

    // Strip the MadCap:conditions= attribute from the rendered tag, then
    // optionally tint the element's background and inject a pill badge.
    let cleanedTag = tagText.replace(CONDITIONS_ATTR_REGEX, "");

    if (showBadges && !isSelfClosing && conditionColors) {
      for (const tag of tagList) {
        const bg = conditionColors.get(tag);
        if (bg) {
          cleanedTag = injectStyleAttribute(cleanedTag, `background-color:${hexToRgba(bg, 0.15)}`);
          break;
        }
      }
    }

    output += cleanedTag;

    if (showBadges && !isSelfClosing) {
      output += renderBadge(tagList, conditionColors);
    }

    cursor = tagEnd + 1;
  }

  return {
    html: output,
    hiddenCount,
    elementConditionCounts,
    snippetConditionCounts
  };
}

function bumpCount(map: Map<string, number>, raw: string): void {
  const tags = parseConditionsAttribute(raw);
  for (const tag of tags) {
    map.set(tag, (map.get(tag) ?? 0) + 1);
  }
}

function findTagEnd(html: string, tagStart: number): number {
  let inQuote: '"' | "'" | undefined;
  for (let i = tagStart + 1; i < html.length; i += 1) {
    const ch = html.charAt(i);
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Walks the HTML starting from `from` looking for the close tag that matches
 * `tagName` at the same depth. Handles nested same-name elements and ignores
 * close tags found inside comments. Returns the offset just past the close
 * tag, or -1 if no matching close was found.
 */
function findMatchingCloseTag(
  html: string,
  tagName: string,
  from: number
): number {
  const lowerTarget = tagName.toLowerCase();
  let depth = 1;
  let cursor = from;
  while (cursor < html.length) {
    const next = html.indexOf("<", cursor);
    if (next === -1) {
      return -1;
    }
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, next);
    if (tagEnd === -1) {
      return -1;
    }
    const tagText = html.slice(next, tagEnd + 1);
    const nameMatch = TAG_NAME_REGEX.exec(tagText);
    if (!nameMatch) {
      cursor = tagEnd + 1;
      continue;
    }
    const lowerName = nameMatch[1].toLowerCase();
    const isClose = tagText.startsWith("</");
    const isSelf = tagText.endsWith("/>") || (!isClose && VOID_ELEMENTS.has(lowerName));

    if (lowerName === lowerTarget) {
      if (isClose) {
        depth -= 1;
        if (depth === 0) {
          return tagEnd + 1;
        }
      } else if (!isSelf) {
        depth += 1;
      }
    }
    cursor = tagEnd + 1;
  }
  return -1;
}

/**
 * Converts a hex color (#RGB or #RRGGBB) to an `rgba(r, g, b, alpha)` string.
 * Returns a transparent fallback for unrecognised formats.
 */
function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace(/^#/, "");
  let r: number, g: number, b: number;
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else if (cleaned.length === 6) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    return `rgba(0,0,0,0)`;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Injects `declaration` into the opening tag's `style` attribute. If the tag
 * already has a `style` attribute the declaration is appended (`;` separated).
 * If not, a new `style="…"` attribute is inserted immediately after the tag name.
 */
function injectStyleAttribute(tagText: string, declaration: string): string {
  const existingStyle = /\bstyle\s*=\s*(["'])([^"']*)\1/i;
  if (existingStyle.test(tagText)) {
    return tagText.replace(existingStyle, (_full, quote, value) => {
      const sep = value.trimEnd().endsWith(";") ? "" : ";";
      return `style=${quote}${value}${sep}${declaration}${quote}`;
    });
  }
  // Insert after `<tagName`.
  const tagNameMatch = tagText.match(/^<([A-Za-z][\w:.-]*)/);
  if (!tagNameMatch) {
    return tagText;
  }
  const insertAt = 1 + tagNameMatch[1].length;
  return `${tagText.slice(0, insertAt)} style="${declaration}"${tagText.slice(insertAt)}`;
}

/**
 * Renders one pill badge per condition tag. Each pill uses a white background
 * with a thick colored border so the condition color is always visible and the
 * text is always readable (black on white = 21:1 contrast). When a tag has no
 * color in the project's .flcts files the CSS fallback style applies.
 *
 * Multiple conditions on one element produce side-by-side pills, each with its
 * own color, so authors can distinguish them at a glance.
 */
function renderBadge(tagList: readonly string[], conditionColors?: Map<string, string>): string {
  if (tagList.length === 0) {
    return "";
  }
  return tagList
    .map((tag) => {
      const escapedTag = escapeHtml(tag);
      const color = conditionColors?.get(tag);
      const styleAttr = color
        ? ` style="background:${hexToRgba(color, 0.15)};border-color:${escapeHtml(color)}"` : "";
      return `<span class="madcap-condition-badge"${styleAttr} title="MadCap:conditions=${escapedTag}">${escapedTag}</span>`;
    })
    .join("");
}


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
