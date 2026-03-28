import * as path from "node:path";
import * as vscode from "vscode";

/** Get the first workspace folder path, or undefined if none. */
export function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

/** Resolve a file path (absolute or relative to workspace root) to a vscode.Uri. */
export function resolveFileUri(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error("No workspace folder found for relative path resolution");
  return vscode.Uri.file(path.join(root.uri.fsPath, filePath));
}

/** Resolve an array of file paths to vscode.Uris. */
export function resolveFileUris(paths: string[]): vscode.Uri[] {
  return paths.map(resolveFileUri);
}

/** Open a text document (ensures LSP sees it). */
export async function ensureDocumentOpen(uri: vscode.Uri): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
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
