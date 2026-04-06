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

export interface PreviewDiagnostics {
  warnings: string[];
}

export interface TransformResult {
  html: string;
  warnings: string[];
}
