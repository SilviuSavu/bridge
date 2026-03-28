import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { logger } from "./logger";
import { resolveFileUri, resolveFileUris, ensureDocumentOpen, getUsageCode, augmentWithUsageCode, getWorkspacePath } from "./utils";
import { resolveSymbolPosition } from "./symbol-resolver";

const execAsync = promisify(exec);

// ── IDE detection ─────────────────────────────────────────────────────

function detectIdeSync(): string {
  const name = vscode.env.appName.toLowerCase();
  if (name.includes("windsurf")) return "windsurf";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("trae")) return "trae";
  if (name.includes("visual studio code")) return "vscode";
  return "unknown";
}

async function detectIde(): Promise<string> {
  try {
    const sync = detectIdeSync();
    if (sync !== "unknown") return sync;
    const cmds = await vscode.commands.getCommands();
    if (cmds.some((c) => c.includes("composer"))) return "cursor";
    if (cmds.some((c) => c.includes("windsurf"))) return "windsurf";
    if (cmds.some((c) => c.includes("icube"))) return "trae";
    return "vscode";
  } catch {
    return "vscode";
  }
}

// ── Serialization helpers ─────────────────────────────────────────────

function serializeRange(r: vscode.Range): { start: { line: number; character: number }; end: { line: number; character: number } } {
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}

function serializeLocation(loc: vscode.Location | vscode.LocationLink): { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } {
  const isLink = "targetUri" in loc;
  const uri = isLink ? loc.targetUri : loc.uri;
  const range = isLink ? loc.targetRange : loc.range;
  return { uri: uri.toString(), range: serializeRange(range) };
}

function safeJsonSerialize(value: unknown): unknown {
  try { JSON.stringify(value); return value; }
  catch {
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return "[Symbol]";
    if (value === undefined) return "[undefined]";
    try { return JSON.parse(JSON.stringify(structuredClone(value))); }
    catch { return String(value); }
  }
}

function convertArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === "string" && (arg.startsWith("file://") || arg.startsWith("vscode://") || arg.startsWith("http://") || arg.startsWith("https://"))) {
      try { return vscode.Uri.parse(arg); } catch { return arg; }
    }
    return arg;
  });
}

// ── Git helpers ───────────────────────────────────────────────────────

async function getGitModifiedFiles(dir: string): Promise<string[]> {
  const files = new Set<string>();
  try {
    const [diff, cached, untracked] = await Promise.all([
      execAsync("git diff --name-only", { cwd: dir }).then((r) => r.stdout).catch(() => ""),
      execAsync("git diff --cached --name-only", { cwd: dir }).then((r) => r.stdout).catch(() => ""),
      execAsync("git ls-files --others --exclude-standard", { cwd: dir }).then((r) => r.stdout).catch(() => ""),
    ]);
    for (const output of [diff, cached, untracked]) {
      if (!output.trim()) continue;
      for (const line of output.trim().split("\n")) {
        if (line.trim()) files.add(path.resolve(dir, line.trim()));
      }
    }
  } catch (err) {
    logger.error(`Error getting git modified files: ${err}`);
  }
  return [...files];
}

async function getAllModifiedFiles(): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return [];
  const rootPath = root.uri.fsPath;
  const files = await getGitModifiedFiles(rootPath);
  // Also check submodules
  try {
    const { stdout } = await execAsync("git submodule --quiet foreach 'echo $sm_path'", { cwd: rootPath });
    if (stdout.trim()) {
      const subPaths = stdout.trim().split("\n").filter((s) => s.trim());
      const subFiles = await Promise.all(subPaths.map((sp) => getGitModifiedFiles(path.resolve(rootPath, sp))));
      files.push(...subFiles.flat());
    }
  } catch { /* no submodules */ }
  return [...new Set(files)];
}

// ── Diagnostics polling ───────────────────────────────────────────────

const DIAG_POLL_INTERVAL_MS = 250;
const DIAG_POLL_TIMEOUT_MS = 15_000;

function snapshotDiagnosticCounts(uris: vscode.Uri[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const uri of uris) {
    counts.set(uri.toString(), vscode.languages.getDiagnostics(uri).length);
  }
  return counts;
}

function waitForDiagnosticsToChange(uris: vscode.Uri[], baseline: Map<string, number>): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + DIAG_POLL_TIMEOUT_MS;
    const check = () => {
      const current = snapshotDiagnosticCounts(uris);
      for (const [key, count] of current) {
        if (count !== baseline.get(key)) { resolve(); return; }
      }
      if (Date.now() >= deadline) { resolve(); return; }
      setTimeout(check, DIAG_POLL_INTERVAL_MS);
    };
    setTimeout(check, DIAG_POLL_INTERVAL_MS);
  });
}

// ══════════════════════════════════════════════════════════════════════
//                         HANDLER IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════════

export const healthHandler = async (_params: Record<string, never>) => {
  try {
    const workspace = getWorkspacePath();
    const ideType = await detectIde();
    return {
      status: "ok" as const,
      extension_version: "4.7.0",
      workspace: workspace ?? undefined,
      timestamp: new Date().toISOString(),
      system_info: { platform: os.platform(), node_version: process.version, vscode_version: vscode.version, ide_type: ideType },
    };
  } catch (err) {
    return {
      status: "error" as const,
      extension_version: "4.7.0",
      timestamp: new Date().toISOString(),
      error: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      system_info: { platform: os.platform(), node_version: process.version, vscode_version: vscode.version, ide_type: "unknown" },
    };
  }
};

export const getDiagnosticsHandler = async (params: { __NOT_RECOMMEND__filePaths: string[]; sources: string[]; severities: string[] }) => {
  let filePaths = params.__NOT_RECOMMEND__filePaths;
  if (filePaths.length === 0) filePaths = await getAllModifiedFiles();

  const uris = resolveFileUris(filePaths);
  const severityMap: Record<number, string> = { 0: "error", 1: "warning", 2: "info", 3: "hint" };

  const files = await Promise.all(uris.map(async (uri) => {
    await ensureDocumentOpen(uri);
    const raw = vscode.languages.getDiagnostics(uri);
    const filtered = raw.filter((d) => {
      const matchSource = params.sources.length === 0 || (d.source ? params.sources.some((s) => d.source!.toLowerCase().includes(s.toLowerCase())) : false);
      const sev = severityMap[d.severity];
      const matchSeverity = params.severities.length === 0 || params.severities.includes(sev);
      return matchSource && matchSeverity;
    });
    return {
      uri: uri.fsPath,
      diagnostics: filtered.map((d) => ({
        range: serializeRange(d.range),
        message: d.message,
        severity: severityMap[d.severity],
        source: d.source,
        code: typeof d.code === "object" ? d.code.value : d.code,
      })),
    };
  }));

  return { files };
};

export const getReferencesHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; includeDeclaration?: boolean; usageCodeLineRange?: number }) => {
  const uri = resolveFileUri(params.filePath);
  await ensureDocumentOpen(uri);
  const pos = await resolveSymbolPosition(uri, params.symbol, params.codeSnippet);
  const refs = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", uri, pos, { includeDeclaration: params.includeDeclaration ?? false });
  if (!refs || refs.length === 0) return { locations: [] };
  const lineRange = params.usageCodeLineRange ?? 5;
  const locations = await Promise.all(refs.map(async (ref) => {
    const loc: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; usageCode?: string } = {
      uri: ref.uri.toString(),
      range: serializeRange(ref.range),
    };
    if (lineRange !== -1) {
      const code = await getUsageCode(ref.uri, ref.range, lineRange);
      if (code) loc.usageCode = code;
    }
    return loc;
  }));
  return { locations };
};

export const getSymbolLSPInfoHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; infoType?: string }) => {
  const { filePath, symbol, codeSnippet, infoType = "all" } = params;
  const types = infoType === "all" ? ["hover", "signature_help", "type_definition", "definition", "implementation"] : [infoType];
  const uri = resolveFileUri(filePath);
  await ensureDocumentOpen(uri);
  const pos = await resolveSymbolPosition(uri, symbol, codeSnippet);
  const result: Record<string, unknown> = {};

  const tasks: Promise<void>[] = [];

  if (types.includes("hover")) tasks.push((async () => {
    try {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos);
      if (hovers?.length) result.hover = hovers.map((h) => ({
        contents: h.contents.map((c) => typeof c === "string" ? c : c instanceof vscode.MarkdownString ? c.value : c.toString()),
        range: h.range ? serializeRange(h.range) : undefined,
      }));
    } catch (e) { result.hover = [{ contents: [`Error: ${e}`] }]; }
  })());

  if (types.includes("signature_help")) tasks.push((async () => {
    try {
      const sh = await vscode.commands.executeCommand<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", uri, pos);
      if (sh) result.signature_help = {
        signatures: sh.signatures.map((s) => ({
          label: s.label,
          documentation: s.documentation instanceof vscode.MarkdownString ? s.documentation.value : typeof s.documentation === "string" ? s.documentation : undefined,
          parameters: s.parameters?.map((p) => ({
            label: typeof p.label === "string" ? p.label : p.label.join(""),
            documentation: p.documentation instanceof vscode.MarkdownString ? p.documentation.value : typeof p.documentation === "string" ? p.documentation : undefined,
          })),
        })),
        activeSignature: sh.activeSignature,
        activeParameter: sh.activeParameter,
      };
    } catch (e) { result.signature_help = { signatures: [{ label: `Error: ${e}`, parameters: [] }], activeSignature: 0, activeParameter: 0 }; }
  })());

  for (const key of ["type_definition", "definition", "implementation"] as const) {
    if (!types.includes(key)) continue;
    const cmd = key === "type_definition" ? "vscode.executeTypeDefinitionProvider" : key === "definition" ? "vscode.executeDefinitionProvider" : "vscode.executeImplementationProvider";
    tasks.push((async () => {
      try {
        const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(cmd, uri, pos);
        if (locs?.length) {
          const serialized = locs.map(serializeLocation);
          result[key] = await augmentWithUsageCode(serialized);
        }
      } catch (e) { result[key] = [{ uri: `error://${key}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, usageCode: `Error: ${e}` }]; }
    })());
  }

  await Promise.all(tasks);
  return result;
};

export const executeCommandHandler = async (params: { command: string; args?: string; saveAllEditors?: boolean }) => {
  try {
    let args: unknown[] = [];
    if (params.args) {
      args = JSON.parse(params.args);
      if (!Array.isArray(args)) throw new TypeError("Args must be an array");
    }
    const converted = convertArgs(args);
    const result = await vscode.commands.executeCommand(params.command, ...converted);
    if (params.saveAllEditors) await vscode.workspace.saveAll(false);
    return { result: safeJsonSerialize(result) };
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : String(err), command: params.command, args: params.args || "" } };
  }
};

export const openFilesHandler = async (params: { files: Array<{ filePath: string; showEditor?: boolean }> }) => ({
  results: await Promise.all(params.files.map(async (f) => {
    try {
      const uri = resolveFileUri(f.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const show = f.showEditor ?? true;
      if (show) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      return { filePath: f.filePath, success: true, message: show ? "File opened and displayed in editor" : "File opened in background" };
    } catch (err) {
      return { filePath: f.filePath, success: false, message: `Failed to open file: ${String(err)}` };
    }
  })),
});

export const renameSymbolHandler = async (params: { filePath: string; symbol: string; newName: string; codeSnippet?: string }) => {
  logger.info(`Renaming symbol "${params.symbol}" in ${params.filePath} to "${params.newName}"`);
  try {
    const uri = resolveFileUri(params.filePath);
    const pos = await resolveSymbolPosition(uri, params.symbol, params.codeSnippet);
    await vscode.workspace.openTextDocument(uri);
    if (!params.newName.trim()) return { success: false, modifiedFiles: [], totalChanges: 0, error: "New name cannot be empty" };

    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", uri, pos, params.newName);
    if (!edit) return { success: false, modifiedFiles: [], totalChanges: 0, error: `Symbol "${params.symbol}" is not renameable` };
    if (!await vscode.workspace.applyEdit(edit)) return { success: false, modifiedFiles: [], totalChanges: 0, error: "Failed to apply rename edits" };

    const modifiedFiles: Array<{ uri: string; changeCount: number }> = [];
    let totalChanges = 0;
    let symbolName = "unknown";
    const entries = edit.entries();
    if (entries.length > 0) {
      const [firstUri, firstEdits] = entries[0];
      if (firstEdits.length > 0) {
        try { symbolName = (await vscode.workspace.openTextDocument(firstUri)).getText(firstEdits[0].range); } catch { /* keep unknown */ }
      }
    }
    for (const [fileUri, edits] of entries) {
      modifiedFiles.push({ uri: fileUri.toString(), changeCount: edits.length });
      totalChanges += edits.length;
    }
    await vscode.workspace.saveAll(false);
    return { success: true, symbolName, modifiedFiles, totalChanges };
  } catch (err) {
    logger.error(`Rename symbol failed: ${err}`);
    return { success: false, modifiedFiles: [], totalChanges: 0, error: `Rename failed: ${err}` };
  }
};

async function revertSingleFile(filePath: string): Promise<{ filePath: string; success: boolean; message: string }> {
  try {
    const uri = resolveFileUri(filePath);
    const diskBytes = await vscode.workspace.fs.readFile(uri);
    const diskContent = new TextDecoder().decode(diskBytes);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editorContent = doc.getText();

    if (editorContent === diskContent) {
      // Force refresh: insert space then replace back
      const endPos = doc.positionAt(editorContent.length);
      const edit1 = new vscode.WorkspaceEdit();
      edit1.insert(uri, endPos, " ");
      await vscode.workspace.applyEdit(edit1);
      const doc2 = await vscode.workspace.openTextDocument(uri);
      const edit2 = new vscode.WorkspaceEdit();
      edit2.replace(uri, new vscode.Range(doc2.positionAt(0), doc2.positionAt(doc2.getText().length)), diskContent);
      await vscode.workspace.applyEdit(edit2);
      await doc2.save();
      return { filePath, success: true, message: "Forced refresh" };
    }

    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(editorContent.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, diskContent);
    if (!await vscode.workspace.applyEdit(edit)) return { filePath, success: false, message: "WorkspaceEdit failed to apply" };
    await doc.save();
    return { filePath, success: true, message: "Reverted from disk" };
  } catch (err) {
    return { filePath, success: false, message: `Failed to revert: ${String(err)}` };
  }
}

export const revertFilesHandler = async (params: { files: string[]; waitForDiagnostics?: boolean }) => {
  const uris = params.files.map(resolveFileUri);
  const baseline = (params.waitForDiagnostics ?? false) ? snapshotDiagnosticCounts(uris) : undefined;
  const results = await Promise.all(params.files.map(revertSingleFile));
  if (baseline) await waitForDiagnosticsToChange(uris, baseline);
  return { results };
};

export const listWorkspacesHandler = async (_params: Record<string, never>) => {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootPath) return { workspaces: [], summary: { total: 0, active: 0, available: 0, cleaned: 0 } };
  const ideType = await detectIde();
  const folders = vscode.workspace.workspaceFolders;
  const workspaceType = folders
    ? (folders.length === 1 ? (vscode.workspace.workspaceFile ? "workspace-file" : "single-folder") : "multi-folder")
    : undefined;
  const workspaceName = vscode.workspace.workspaceFile
    ? vscode.workspace.workspaceFile.path.split("/").at(-1)?.replace(".code-workspace", "")
    : folders?.length === 1 ? folders[0].name : folders?.map((f) => f.name).join(", ");

  return {
    workspaces: [{
      workspace_path: rootPath,
      workspace_name: workspaceName,
      workspace_type: workspaceType,
      folders: folders?.map((f) => f.uri.fsPath),
      status: "active" as const,
      extension_version: "4.7.0",
      vscode_version: vscode.version,
      ide_type: ideType,
    }],
    summary: { total: 1, active: 1, available: 0, cleaned: 0 },
  };
};

// ── New handlers ──────────────────────────────────────────────────────

export const getCodeActionsHandler = async (params: { filePath: string; line: number; character: number; endLine?: number; endCharacter?: number; kind?: string }) => {
  const uri = resolveFileUri(params.filePath);
  await ensureDocumentOpen(uri);
  const startPos = new vscode.Position(params.line, params.character);
  const endPos = new vscode.Position(params.endLine ?? params.line, params.endCharacter ?? params.character);
  const range = new vscode.Range(startPos, endPos);

  const raw = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
    params.kind ? new vscode.CodeActionKind(params.kind) : undefined,
  );

  if (!raw || raw.length === 0) return { actions: [] };
  return {
    actions: raw.map((a) => ({
      title: a.title || "",
      kind: a.kind ? a.kind.value : undefined,
      isPreferred: a.isPreferred || false,
    })),
  };
};

export const getCallHierarchyHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; direction?: string }) => {
  const uri = resolveFileUri(params.filePath);
  await ensureDocumentOpen(uri);
  const pos = await resolveSymbolPosition(uri, params.symbol, params.codeSnippet);

  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", uri, pos);
  if (!items || items.length === 0) throw new Error("Call hierarchy not available for this symbol (LSP returned no items)");
  const item = items[0];

  const serializeItem = (i: vscode.CallHierarchyItem) => ({
    name: i.name,
    kind: i.kind,
    uri: i.uri.toString(),
    detail: i.detail || undefined,
    range: serializeRange(i.range),
  });

  const result: { incoming?: unknown[]; outgoing?: unknown[] } = {};
  const dir = params.direction || "both";

  if (dir === "incoming" || dir === "both") {
    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", item);
    if (incoming?.length) result.incoming = incoming.map((c) => ({ from: serializeItem(c.from), fromRanges: c.fromRanges.map(serializeRange) }));
  }

  if (dir === "outgoing" || dir === "both") {
    const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", item);
    if (outgoing?.length) result.outgoing = outgoing.map((c) => ({ to: serializeItem(c.to), fromRanges: c.fromRanges.map(serializeRange) }));
  }

  return result;
};
