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

const SCRIPT_TAG_REGEX = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const SELF_CLOSING_SCRIPT_REGEX = /<script\b[^>]*\/>/gi;
const IFRAME_TAG_REGEX = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi;
const OBJECT_TAG_REGEX = /<(object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_OBJECT_REGEX = /<(object|embed|applet)\b[^>]*\/>/gi;
const STYLE_TAG_REGEX = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const META_REFRESH_REGEX = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
const EVENT_HANDLER_REGEX = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL_REGEX = /\b(href|src|xlink:href|formaction|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi;
const DATA_URL_IN_HREF_REGEX = /\b(href|src)\s*=\s*(["'])\s*data:(?!image\/(?:png|jpe?g|gif|svg\+xml|webp))[^"']*\2/gi;

export function sanitizeHtml(html: string): SanitizeResult {
  const removed: string[] = [];
  let output = html;

  output = stripWithReport(output, SCRIPT_TAG_REGEX, "script tag", removed);
  output = stripWithReport(output, SELF_CLOSING_SCRIPT_REGEX, "script tag", removed);
  output = stripWithReport(output, IFRAME_TAG_REGEX, "iframe tag", removed);
  output = stripWithReport(output, OBJECT_TAG_REGEX, "object/embed/applet tag", removed);
  output = stripWithReport(output, SELF_CLOSING_OBJECT_REGEX, "object/embed/applet tag", removed);
  output = stripWithReport(output, STYLE_TAG_REGEX, "inline <style> block", removed);
  output = stripWithReport(output, META_REFRESH_REGEX, "meta refresh", removed);

  if (EVENT_HANDLER_REGEX.test(output)) {
    removed.push("inline event handler");
    EVENT_HANDLER_REGEX.lastIndex = 0;
    output = output.replace(EVENT_HANDLER_REGEX, "");
  }

  if (JAVASCRIPT_URL_REGEX.test(output)) {
    removed.push("javascript: URL");
    JAVASCRIPT_URL_REGEX.lastIndex = 0;
    output = output.replace(JAVASCRIPT_URL_REGEX, (_match, attr: string) => `${attr}="#"`);
  }

  if (DATA_URL_IN_HREF_REGEX.test(output)) {
    removed.push("non-image data: URL");
    DATA_URL_IN_HREF_REGEX.lastIndex = 0;
    output = output.replace(DATA_URL_IN_HREF_REGEX, (_match, attr: string) => `${attr}="#"`);
  }

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

function stripWithReport(
  html: string,
  regex: RegExp,
  label: string,
  removed: string[]
): string {
  regex.lastIndex = 0;
  if (!regex.test(html)) {
    return html;
  }
  removed.push(label);
  regex.lastIndex = 0;
  return html.replace(regex, "");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
