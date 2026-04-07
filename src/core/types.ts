import * as vscode from "vscode";

export interface FlareProjectContext {
  projectFile: vscode.Uri;
  projectRoot: vscode.Uri;
  variableFiles: vscode.Uri[];
  referencedStylesheets: vscode.Uri[];
}

export interface VariableResolutionResult {
  variables: Map<string, string>;
  unresolvedReferences: string[];
}

export interface StylesheetBundle {
  stylesheets: vscode.Uri[];
  inlinedCss: Array<{
    source: vscode.Uri;
    content: string;
  }>;
  missingStylesheets: string[];
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticCode =
  | "project-missing"
  | "variable-unresolved"
  | "stylesheet-missing"
  | "snippet-missing"
  | "unsupported-tag"
  | "transform-failed"
  | "resolve-failed"
  | "sanitize-failed"
  | "render-failed";

export interface DiagnosticEntry {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  hint?: string;
  source?: string;
}

export interface PreviewDiagnostics {
  entries: DiagnosticEntry[];
}

export interface TransformResult {
  html: string;
  warnings: string[];
}

export interface PreviewConditionInventory {
  elementConditionCounts: Map<string, number>;
  snippetConditionCounts: Map<string, number>;
  hiddenCount: number;
}

export interface PreviewTargetInfo {
  id: string;
  displayName: string;
  expression: string | undefined;
}
