import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("MadCap Flare Preview");
  }
  return channel;
}

export function logInfo(message: string): void {
  getChannel().appendLine(`[info] ${timestamp()} ${message}`);
}

export function logWarning(message: string): void {
  getChannel().appendLine(`[warn] ${timestamp()} ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const channelRef = getChannel();
  channelRef.appendLine(`[error] ${timestamp()} ${message}`);
  if (error instanceof Error) {
    channelRef.appendLine(`        ${error.message}`);
    if (error.stack) {
      channelRef.appendLine(error.stack);
    }
  } else if (error !== undefined) {
    channelRef.appendLine(`        ${String(error)}`);
  }
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}
