import * as vscode from "vscode";
import { FlareProjectResolver } from "../core/flareProjectResolver";
import { ConditionTagIndex } from "../flare/conditionTagIndex";
import { parseConditionsAttribute } from "../flare/conditionExpression";

const CONDITIONS_ATTR_REGEX =
  /\b(?:MadCap:conditions|MadCap:conditionTagExpression)\s*=\s*(["'])([^"']*)\1/gi;
const FALLBACK_COLOR = "#888888";

interface DecorationGroup {
  color: string;
  type: vscode.TextEditorDecorationType;
  ranges: vscode.Range[];
}

/**
 * Inline gutter decorations for `MadCap:conditions=` and
 * `MadCap:conditionTagExpression=` attributes. Each line that contains a
 * conditional attribute gets a small colored square in the gutter, taking
 * its color from the `BackgroundColor` of the first qualified tag's `.flcts`
 * entry. The square is rendered from a generated SVG `data:` URI so the
 * extension doesn't have to ship a static image asset.
 *
 * When a line carries multiple tags from differently-colored sets the first
 * tag wins — visual cue, not a data structure. Tags that aren't present in
 * the index get a neutral grey square so authors still see "this line has a
 * condition", even if the index hasn't refreshed yet.
 */
export class ConditionGutterDecorations implements vscode.Disposable {
  private readonly decorationCache = new Map<string, vscode.TextEditorDecorationType>();
  private readonly listeners: vscode.Disposable[] = [];
  private enabled: boolean;

  public constructor(
    private readonly projectResolver: FlareProjectResolver,
    private readonly conditionTagIndex: ConditionTagIndex
  ) {
    this.enabled = readEnabledSetting();

    this.listeners.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          void this.refresh(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.visibleTextEditors.find(
          (visible) => visible.document === event.document
        );
        if (editor) {
          void this.refresh(editor);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("flarePreview.showConditionGutter")) {
          this.enabled = readEnabledSetting();
          this.refreshAll();
        }
      })
    );

    for (const editor of vscode.window.visibleTextEditors) {
      void this.refresh(editor);
    }
  }

  public refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.refresh(editor);
    }
  }

  public async refresh(editor: vscode.TextEditor): Promise<void> {
    if (!isFlareTopic(editor.document)) {
      return;
    }

    if (!this.enabled) {
      // Clear any decorations that were applied while the setting was on.
      for (const decorationType of this.decorationCache.values()) {
        editor.setDecorations(decorationType, []);
      }
      return;
    }

    const projectContext = await this.projectResolver
      .resolveForFile(editor.document.uri)
      .catch(() => undefined);

    const indexEntries = projectContext
      ? await this.conditionTagIndex.getEntries(projectContext)
      : [];
    const colorByQualified = new Map<string, string>();
    for (const entry of indexEntries) {
      if (entry.color) {
        colorByQualified.set(entry.qualifiedName, normalizeColor(entry.color));
      }
    }

    const document = editor.document;
    const text = document.getText();
    const groups = new Map<string, DecorationGroup>();

    CONDITIONS_ATTR_REGEX.lastIndex = 0;
    let match = CONDITIONS_ATTR_REGEX.exec(text);
    while (match) {
      const value = match[2] ?? "";
      const tagList = parseConditionsAttribute(value);
      const firstColor = pickFirstColor(tagList, colorByQualified);
      const valueStart = match.index + match[0].length - 1 - value.length;
      const position = document.positionAt(valueStart);
      const lineRange = document.lineAt(position.line).range;
      const group = this.getOrCreateGroup(groups, firstColor);
      group.ranges.push(lineRange);
      match = CONDITIONS_ATTR_REGEX.exec(text);
    }

    // Clear every cached decoration type for this editor first; otherwise
    // a tag that disappeared from the document would leave a stale gutter.
    for (const decorationType of this.decorationCache.values()) {
      editor.setDecorations(decorationType, []);
    }
    for (const group of groups.values()) {
      editor.setDecorations(group.type, group.ranges);
    }
  }

  private getOrCreateGroup(
    groups: Map<string, DecorationGroup>,
    color: string
  ): DecorationGroup {
    const cached = groups.get(color);
    if (cached) {
      return cached;
    }
    const decorationType = this.getOrCreateDecorationType(color);
    const fresh: DecorationGroup = {
      color,
      type: decorationType,
      ranges: []
    };
    groups.set(color, fresh);
    return fresh;
  }

  private getOrCreateDecorationType(color: string): vscode.TextEditorDecorationType {
    const existing = this.decorationCache.get(color);
    if (existing) {
      return existing;
    }
    const dataUri = vscode.Uri.parse(svgGutterDataUri(color));
    const decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: dataUri,
      gutterIconSize: "60%",
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Center
    });
    this.decorationCache.set(color, decorationType);
    return decorationType;
  }

  public dispose(): void {
    for (const listener of this.listeners) {
      listener.dispose();
    }
    this.listeners.length = 0;
    for (const decorationType of this.decorationCache.values()) {
      decorationType.dispose();
    }
    this.decorationCache.clear();
  }
}

function pickFirstColor(
  tagList: readonly string[],
  colorByQualified: Map<string, string>
): string {
  for (const tag of tagList) {
    const cleaned = tag
      .replace(/^(?:include|exclude)\s*\[/i, "")
      .replace(/\]$/, "")
      .replace(/^!/, "")
      .replace(/^not\s+/i, "")
      .trim();
    const found = colorByQualified.get(cleaned);
    if (found) {
      return found;
    }
  }
  return FALLBACK_COLOR;
}

// CSS named colors that Flare authors commonly drop into a `.flcts`
// `BackgroundColor` attribute. SVG accepts these natively, but we still
// need to recognize them as "valid" so they don't fall through to the
// grey fallback. The list mirrors the CSS3 named-color set, lowercased
// for case-insensitive lookup.
const CSS_NAMED_COLORS = new Set<string>([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen",
  "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid",
  "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen",
  "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose",
  "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
  "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue",
  "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna",
  "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow",
  "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
  "transparent"
]);

/**
 * Coerces a `BackgroundColor` value from a `.flcts` `<ConditionTag>` entry
 * into a string the gutter SVG can use as `fill`. Real Flare projects mix
 * three formats:
 *
 *   - Hex: `#008000` or `#fff` (CSS standard, the most reliable form)
 *   - Hex with alpha: `#008000ff` (we strip the alpha for the gutter)
 *   - CSS named colors: `Blue`, `Red`, `Green`, `Forest Green` etc.
 *
 * Anything else falls back to a neutral grey so authors still see *that*
 * the line is conditional, just without the per-tag color cue.
 */
function normalizeColor(color: string): string {
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed)) {
    return trimmed;
  }
  // Strip any trailing alpha for #RRGGBBAA hex.
  if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return trimmed.slice(0, 7);
  }
  // CSS named color lookup (case-insensitive). Whitespace is stripped so
  // names Flare sometimes serializes with embedded spaces still match.
  const collapsed = trimmed.replace(/\s+/g, "").toLowerCase();
  if (CSS_NAMED_COLORS.has(collapsed)) {
    return collapsed;
  }
  return FALLBACK_COLOR;
}

/**
 * Generates a data: URI for a 16x16 SVG containing a colored, slightly
 * rounded square. Used as the gutter icon. The encoder is intentionally
 * minimal — VS Code accepts URL-encoded SVG data URIs and that's all we
 * need.
 */
export function svgGutterDataUri(color: string): string {
  const safeColor = normalizeColor(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" ry="2" fill="${safeColor}" stroke="#0006" stroke-width="1"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}

function readEnabledSetting(): boolean {
  return vscode.workspace
    .getConfiguration("flarePreview")
    .get<boolean>("showConditionGutter", true);
}
