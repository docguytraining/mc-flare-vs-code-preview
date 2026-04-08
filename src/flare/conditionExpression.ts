/**
 * Minimal evaluator for the Flare condition expression language as it appears
 * in `.fltar` (target) files and the project's `PreviewConditionalExpression`.
 *
 * Supported forms:
 *
 *   include[A]                      → element shown only if A is on its tag list
 *   exclude[A]                      → element hidden if A is on its tag list
 *   include[A or B]                 → boolean OR
 *   include[A and B]                → boolean AND
 *   exclude[A or (B and C)]         → grouping with parentheses
 *   include[A] AND exclude[B]       → top-level AND of clauses
 *
 * Tag list shorthand on individual elements (`MadCap:conditions="A,B,C"`) is
 * **not** an expression — it's a comma-separated list. The pipeline treats it
 * as the set of tags carried by that element, not as something to evaluate.
 *
 * The evaluator's contract is simple: given a target expression and the set
 * of condition tags an element carries, return whether the element should
 * render. When the expression is empty, missing, or only whitespace, the
 * default is to render.
 */

export type ConditionTagSet = ReadonlySet<string>;

export interface ConditionExpression {
  evaluate(elementTags: ConditionTagSet): boolean;
}

const ALWAYS_RENDER: ConditionExpression = {
  evaluate: () => true
};

export function alwaysRender(): ConditionExpression {
  return ALWAYS_RENDER;
}

/**
 * Parses a target-style condition expression. Returns an evaluator that
 * decides whether an element with a given set of condition tags should be
 * rendered. Unparseable input falls back to "always render" so a malformed
 * target string can never make the preview disappear silently.
 */
export function parseTargetExpression(input: string | undefined | null): ConditionExpression {
  if (input === undefined || input === null) {
    return ALWAYS_RENDER;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return ALWAYS_RENDER;
  }

  // Reject obviously malformed expressions before trying to compile. Mismatched
  // square or round brackets mean we'd otherwise fall through to the bare-tag
  // branch and silently treat `include[unclosed` as a tag name. Falling back
  // to always-render is much safer than hiding content based on garbage.
  if (!hasBalancedBrackets(trimmed)) {
    return ALWAYS_RENDER;
  }

  try {
    const clauses = splitTopLevel(trimmed, /\bAND\b/i);
    const compiled = clauses.map((clause) => compileClause(clause.trim()));
    if (compiled.length === 0) {
      return ALWAYS_RENDER;
    }
    return {
      evaluate(elementTags) {
        for (const clause of compiled) {
          if (!clause(elementTags)) {
            return false;
          }
        }
        return true;
      }
    };
  } catch {
    return ALWAYS_RENDER;
  }
}

/**
 * Decides whether an element carrying the given comma-separated tag list
 * should render under a parsed target expression. Empty tag lists always
 * render — the element has no conditions.
 */
export function shouldRenderForTags(
  expression: ConditionExpression,
  tagList: readonly string[]
): boolean {
  const tagSet = new Set(tagList.map((tag) => tag.trim()).filter((tag) => tag.length > 0));
  return expression.evaluate(tagSet);
}

/** Parses a `MadCap:conditions="A,B"` attribute value into the tag list. */
export function parseConditionsAttribute(value: string | undefined | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type Predicate = (tags: ConditionTagSet) => boolean;

function compileClause(clause: string): Predicate {
  const includeMatch = /^include\s*\[(.+)\]$/i.exec(clause);
  if (includeMatch) {
    const inner = compileBoolean(includeMatch[1]);
    return (tags) => inner(tags);
  }
  const excludeMatch = /^exclude\s*\[(.+)\]$/i.exec(clause);
  if (excludeMatch) {
    const inner = compileBoolean(excludeMatch[1]);
    return (tags) => !inner(tags);
  }
  // Bare tag-or-expression treated as include[…].
  return compileBoolean(clause);
}

function compileBoolean(text: string): Predicate {
  const stripped = stripOuterParens(text.trim());

  // Top-level OR splits before AND because OR has lower precedence.
  const orParts = splitTopLevel(stripped, /\bor\b/i);
  if (orParts.length > 1) {
    const compiled = orParts.map((part) => compileBoolean(part.trim()));
    return (tags) => compiled.some((predicate) => predicate(tags));
  }

  const andParts = splitTopLevel(stripped, /\band\b/i);
  if (andParts.length > 1) {
    const compiled = andParts.map((part) => compileBoolean(part.trim()));
    return (tags) => compiled.every((predicate) => predicate(tags));
  }

  // NOT prefix.
  const notMatch = /^(?:not\s+|!\s*)(.+)$/i.exec(stripped);
  if (notMatch) {
    const inner = compileBoolean(notMatch[1]);
    return (tags) => !inner(tags);
  }

  // Parenthesised single sub-expression.
  if (stripped.startsWith("(") && stripped.endsWith(")")) {
    return compileBoolean(stripped.slice(1, -1));
  }

  // Bare qualified tag — match the element's tag set.
  const tagName = stripped.replace(/[\[\]]/g, "").trim();
  if (!tagName) {
    return () => true;
  }
  return (tags) => tags.has(tagName);
}

/**
 * Splits a string at every occurrence of `separator` that lives at the top
 * level (not inside parentheses or square brackets). Used so `A or (B and C)`
 * splits to `["A", "(B and C)"]` instead of three pieces.
 */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let lastIndex = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    // Match the separator regex at this position.
    const remaining = text.slice(i);
    const match = remaining.match(separator);
    if (match && match.index === 0) {
      parts.push(text.slice(lastIndex, i));
      lastIndex = i + match[0].length;
      i += match[0].length - 1;
    }
  }

  parts.push(text.slice(lastIndex));
  return parts;
}

function hasBalancedBrackets(text: string): boolean {
  let square = 0;
  let round = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    else if (ch === "(") round += 1;
    else if (ch === ")") round -= 1;
    if (square < 0 || round < 0) {
      return false;
    }
  }
  return square === 0 && round === 0;
}

function stripOuterParens(text: string): string {
  let current = text.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    // Only strip if the leading `(` matches the trailing `)`.
    let depth = 0;
    let matchesOuter = true;
    for (let i = 0; i < current.length; i += 1) {
      const ch = current.charAt(i);
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0 && i !== current.length - 1) {
          matchesOuter = false;
          break;
        }
      }
    }
    if (!matchesOuter) {
      return current;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}
