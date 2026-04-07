import * as vscode from "vscode";

/**
 * Returns true if the document is a Flare topic (.htm or .html) or snippet (.flsnp) file.
 * These file types support MadCap elements and attributes like conditions, variables, xrefs, etc.
 */
export function isFlareDocument(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html") || lower.endsWith(".flsnp");
}

/**
 * Returns true if the document is a Flare topic file (.htm or .html).
 * @deprecated Use isFlareDocument() instead to include snippet files
 */
export function isFlareTopic(document: vscode.TextDocument): boolean {
  const lower = document.uri.fsPath.toLowerCase();
  return lower.endsWith(".htm") || lower.endsWith(".html");
}
