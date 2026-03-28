import * as path from "node:path";
import * as vscode from "vscode";

/** Sleep for a given number of seconds. */
export async function sleep(seconds: number): Promise<void> {
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

/** Copy opened files' paths to clipboard or send to terminal. */
export async function copyOpenedFilesPath(opts: {
  isSendToActiveTerminal?: boolean;
  includeAtSymbol?: boolean;
  addQuotes?: boolean;
  focusTerminal?: boolean;
} = {}): Promise<void> {
  const { isSendToActiveTerminal = false, includeAtSymbol = false, addQuotes = true, focusTerminal = false } = opts;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const filePaths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri;
        if (uri.scheme !== "file") continue;
        const fp = uri.fsPath;
        filePaths.push(rootPath ? (() => { const rel = path.relative(rootPath, fp); return rel.startsWith("..") ? fp : rel; })() : fp);
      }
    }
  }
  const unique = [...new Set(filePaths)].toSorted();
  if (unique.length === 0) return;
  const text = unique.map((p) => {
    const withAt = includeAtSymbol ? `@${p}` : p;
    return addQuotes ? `'${withAt}'` : withAt;
  }).join("\n");
  if (isSendToActiveTerminal) {
    const terminal = vscode.window.activeTerminal;
    if (terminal) { terminal.sendText(text); if (focusTerminal) terminal.show(); }
  } else {
    await vscode.env.clipboard.writeText(text);
  }
}

/** Copy current selection reference (file:line range) to clipboard or terminal. */
export async function copyCurrentSelectionReference(opts: {
  isSendToActiveTerminal?: boolean;
  includeRange?: boolean;
  includeAtSymbol?: boolean;
  addSpaces?: boolean;
  focusTerminal?: boolean;
} = {}): Promise<void> {
  const { isSendToActiveTerminal = false, includeRange = true, includeAtSymbol = true, addSpaces = false, focusTerminal = false } = opts;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const uri = editor.document.uri;
  if (uri.scheme !== "file") return;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const filePath = rootPath ? (() => { const rel = path.relative(rootPath, uri.fsPath); return rel.startsWith("..") ? uri.fsPath : rel; })() : uri.fsPath;

  let ref = filePath;
  const sel = editor.selection;
  if (includeRange && !sel.isEmpty) {
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    ref += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`;
  }
  if (includeAtSymbol) ref = `@${ref}`;
  if (addSpaces) ref = ` ${ref} `;

  if (isSendToActiveTerminal) {
    const terminal = vscode.window.activeTerminal;
    if (terminal) { terminal.sendText(ref, false); if (focusTerminal) terminal.show(); }
  } else {
    await vscode.env.clipboard.writeText(ref);
  }
}
