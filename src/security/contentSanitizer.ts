/**
 * Best-effort HTML sanitizer for preview rendering.
 *
 * This is intentionally conservative and regex-based rather than a full DOM
 * sanitizer: the preview renders trusted topic content from the user's own
 * workspace, so the sanitizer's job is to defuse obvious script injection
 * surfaces (script tags, inline event handlers, javascript: URIs) and to
 * strip external resource references that would bypass the webview CSP.
 *
 * It is NOT a substitute for a proper DOM parser and should not be relied on
 * to sanitize untrusted third-party HTML.
 */

export interface SanitizeResult {
  html: string;
  removed: string[];
}

// End-tag regexes follow the HTML5 parser rule: `</tag` followed by ASCII
// whitespace, `/`, or `>` is an end tag, with anything up to the next `>`
// treated as ignored attributes. So `</script\n foo bar>` really does close
// a <script>. `\b` keeps us from matching `</scripts>` etc.
const SCRIPT_TAG_REGEX = /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi;
const SELF_CLOSING_SCRIPT_REGEX = /<script\b[^>]*\/>/gi;
const IFRAME_TAG_REGEX = /<iframe\b[^>]*>[\s\S]*?<\/iframe\b[^>]*>/gi;
const OBJECT_TAG_REGEX = /<(object|embed|applet)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
const SELF_CLOSING_OBJECT_REGEX = /<(object|embed|applet)\b[^>]*\/>/gi;
const STYLE_TAG_REGEX = /<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi;
const META_REFRESH_REGEX = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
const EVENT_HANDLER_REGEX = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL_REGEX = /\b(href|src|xlink:href|formaction|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi;
const DATA_URL_IN_HREF_REGEX = /\b(href|src)\s*=\s*(["'])\s*data:(?!image\/(?:png|jpe?g|gif|svg\+xml|webp))[^"']*\2/gi;

export function sanitizeHtml(html: string): SanitizeResult {
  const removed: string[] = [];
  let output = html;

  // Each strip is run to a fixpoint so nested obfuscation like
  // `<scr<script>ipt>` or `on<onclick>click=` cannot survive — removing the
  // inner token would otherwise leave a fresh dangerous token behind.
  output = stripUntilStable(output, SCRIPT_TAG_REGEX, "script tag", removed);
  output = stripUntilStable(output, SELF_CLOSING_SCRIPT_REGEX, "script tag", removed);
  output = stripUntilStable(output, IFRAME_TAG_REGEX, "iframe tag", removed);
  output = stripUntilStable(output, OBJECT_TAG_REGEX, "object/embed/applet tag", removed);
  output = stripUntilStable(output, SELF_CLOSING_OBJECT_REGEX, "object/embed/applet tag", removed);
  output = stripUntilStable(output, STYLE_TAG_REGEX, "inline <style> block", removed);
  output = stripUntilStable(output, META_REFRESH_REGEX, "meta refresh", removed);

  output = replaceUntilStable(
    output,
    EVENT_HANDLER_REGEX,
    () => "",
    "inline event handler",
    removed
  );
  output = replaceUntilStable(
    output,
    JAVASCRIPT_URL_REGEX,
    (_match: string, attr: string) => `${attr}="#"`,
    "javascript: URL",
    removed
  );
  output = replaceUntilStable(
    output,
    DATA_URL_IN_HREF_REGEX,
    (_match: string, attr: string) => `${attr}="#"`,
    "non-image data: URL",
    removed
  );

  return { html: output, removed: dedupe(removed) };
}

/**
 * Scrubs external @import and url() references from CSS to keep the preview
 * from reaching out to the network. Local url() references have already been
 * resolved at this point by the stylesheet resolver.
 */
export function sanitizeCss(css: string): { css: string; removed: number } {
  let removed = 0;
  let output = css;

  output = output.replace(/@import\s+(?:url\()?\s*["']?(https?:\/\/|\/\/)[^"')]+["']?\s*\)?\s*;?/gi, () => {
    removed += 1;
    return "";
  });

  output = output.replace(/url\(\s*["']?(https?:\/\/|\/\/)[^"')]+["']?\s*\)/gi, () => {
    removed += 1;
    return "url('#blocked-external')";
  });

  return { css: output, removed };
}

function stripUntilStable(
  html: string,
  regex: RegExp,
  label: string,
  removed: string[]
): string {
  return replaceUntilStable(html, regex, () => "", label, removed);
}

// Iterates `replace` to a fixpoint so removing one match cannot synthesize a
// new one (e.g. `<scr<script>ipt>` → `<script>` after one pass). The loop is
// the canonical CodeQL-recognized form: each iteration both reads and writes
// `current`, and the loop terminates when no further substitutions occur.
function replaceUntilStable(
  html: string,
  regex: RegExp,
  replacement: (match: string, ...groups: string[]) => string,
  label: string,
  removed: string[]
): string {
  let previous: string;
  let current = html;
  let didReplace = false;
  do {
    previous = current;
    regex.lastIndex = 0;
    current = previous.replace(regex, (match, ...args) => {
      didReplace = true;
      // The trailing args from String.replace are: ...captures, offset, full
      // string. We only forward the captures to the caller's replacement.
      const captures = args.slice(0, -2) as string[];
      return replacement(match, ...captures);
    });
  } while (current !== previous);
  if (didReplace) {
    removed.push(label);
  }
  return current;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
