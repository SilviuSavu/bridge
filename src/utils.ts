import * as path from "node:path";
import * as vscode from "vscode";

export const EXTENSION_VERSION = "4.7.0";

/** Check if a file path is within the current workspace. */
export function isInWorkspace(filePath: string): boolean {
  const root = getWorkspacePath();
  if (!root) return false;
  return path.resolve(filePath).startsWith(path.resolve(root));
}

/** Get the first workspace folder path, or undefined if none. */
export function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

/** Resolve a file path (absolute or relative to workspace root) to a vscode.Uri. */
export function resolveFileUri(filePath: string, workspaceRoot?: string): vscode.Uri {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
  if (workspaceRoot) return vscode.Uri.file(path.join(workspaceRoot, filePath));
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error("No workspace folder found for relative path resolution");
  return vscode.Uri.file(path.join(root.uri.fsPath, filePath));
}

/** Resolve an array of file paths to vscode.Uris. */
export function resolveFileUris(paths: string[], workspaceRoot?: string): vscode.Uri[] {
  return paths.map((p) => resolveFileUri(p, workspaceRoot));
}

/** Open a text document so the language server sees it. Does not save. */
export async function ensureDocumentOpen(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    console.warn(`Could not open file ${uri.toString()}: ${err}`);
  }
}

/** Get surrounding code context around a range. */
export async function getUsageCode(
  uri: vscode.Uri,
  range: vscode.Range,
  lineRange: number = 5,
): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (lineRange === -1) return undefined;
    if (lineRange === 0) return doc.lineAt(range.start.line).text;
    const startLine = Math.max(0, range.start.line - lineRange);
    const endLine = Math.min(doc.lineCount - 1, range.start.line + lineRange);
    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) lines.push(doc.lineAt(i).text);
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

/** Normalize a leading `@` from file paths (some models include it). */
export function stripLeadingAt(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/** Augment location results with usageCode. */
export async function augmentWithUsageCode(
  locations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>,
  lineRange: number = 5,
): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; usageCode?: string }>> {
  return Promise.all(locations.map(async (loc) => {
    const code = await getUsageCode(
      vscode.Uri.parse(loc.uri),
      new vscode.Range(
        new vscode.Position(loc.range.start.line, loc.range.start.character),
        new vscode.Position(loc.range.end.line, loc.range.end.character),
      ),
      lineRange,
    );
    return { ...loc, ...(code && { usageCode: code }) };
  }));
}
