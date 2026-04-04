import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { logger } from "./logger";
import { resolveFileUri, resolveFileUris, ensureDocumentOpen, getUsageCode, augmentWithUsageCode, getWorkspacePath, EXTENSION_VERSION } from "./utils";
import { resolveSymbolPosition } from "./symbol-resolver";
import type { RequestContext } from "./socket-server";

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

// ── Completion kind mapping ───────────────────────────────────────────

const COMPLETION_KIND_NAMES: Record<number, string> = {
  0: "text", 1: "method", 2: "function", 3: "constructor", 4: "field",
  5: "variable", 6: "class", 7: "interface", 8: "module", 9: "property",
  10: "unit", 11: "value", 12: "enum", 13: "keyword", 14: "snippet",
  15: "color", 16: "file", 17: "reference", 18: "folder", 19: "enumMember",
  20: "constant", 21: "struct", 22: "event", 23: "operator", 24: "typeParameter",
  25: "user", 26: "issue",
};

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

async function getAllModifiedFiles(workspaceRoot?: string): Promise<string[]> {
  const rootPath = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootPath) return [];
  const files = await getGitModifiedFiles(rootPath);
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

// ── Document symbol serialization ─────────────────────────────────────

function serializeDocumentSymbol(sym: vscode.DocumentSymbol): {
  name: string; kind: number; range: ReturnType<typeof serializeRange>;
  selectionRange: ReturnType<typeof serializeRange>; detail?: string; children?: unknown[];
} {
  const out: {
    name: string; kind: number; range: ReturnType<typeof serializeRange>;
    selectionRange: ReturnType<typeof serializeRange>; detail?: string; children?: unknown[];
  } = {
    name: sym.name,
    kind: sym.kind,
    range: serializeRange(sym.range),
    selectionRange: serializeRange(sym.selectionRange),
  };
  if (sym.detail) out.detail = sym.detail;
  if (sym.children && sym.children.length > 0) {
    out.children = sym.children.map(serializeDocumentSymbol);
  }
  return out;
}

// ── Full-document range helper ────────────────────────────────────────

async function getFullDocumentRange(uri: vscode.Uri): Promise<vscode.Range> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length),
  );
}

// ══════════════════════════════════════════════════════════════════════
//                     ORIGINAL HANDLER IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════════

export const healthHandler = async (_params: Record<string, never>, ctx: RequestContext) => {
  try {
    const workspace = ctx.workspaceFolder;
    const ideType = await detectIde();
    return {
      status: "ok" as const,
      extension_version: EXTENSION_VERSION,
      workspace: workspace ?? undefined,
      timestamp: new Date().toISOString(),
      system_info: { platform: os.platform(), node_version: process.version, vscode_version: vscode.version, ide_type: ideType },
    };
  } catch (err) {
    return {
      status: "error" as const,
      extension_version: EXTENSION_VERSION,
      timestamp: new Date().toISOString(),
      error: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      system_info: { platform: os.platform(), node_version: process.version, vscode_version: vscode.version, ide_type: "unknown" },
    };
  }
};

export const getDiagnosticsHandler = async (params: { filePaths: string[]; sources: string[]; severities: string[] }, ctx: RequestContext) => {
  let filePaths = params.filePaths;
  if (filePaths.length === 0) filePaths = await getAllModifiedFiles(ctx.workspaceFolder);

  const uris = resolveFileUris(filePaths, ctx.workspaceFolder);
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

export const getReferencesHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; includeDeclaration?: boolean; usageCodeLineRange?: number }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
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

export const getSymbolLSPInfoHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; infoType?: string }, ctx: RequestContext) => {
  const { filePath, symbol, codeSnippet, infoType = "all" } = params;
  const types = infoType === "all" ? ["hover", "signature_help", "type_definition", "definition", "implementation"] : [infoType];
  const uri = resolveFileUri(filePath, ctx.workspaceFolder);
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
    } catch (e) { logger.error(`hover provider failed: ${e}`); }
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
    } catch (e) { logger.error(`signature_help provider failed: ${e}`); }
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
      } catch (e) { logger.error(`${key} provider failed: ${e}`); }
    })());
  }

  await Promise.all(tasks);
  return result;
};

export const executeCommandHandler = async (params: { command: string; args?: string; saveAllEditors?: boolean }, _ctx: RequestContext) => {
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

export const openFilesHandler = async (params: { files: Array<{ filePath: string; showEditor?: boolean }> }, ctx: RequestContext) => ({
  results: await Promise.all(params.files.map(async (f) => {
    try {
      const uri = resolveFileUri(f.filePath, ctx.workspaceFolder);
      const doc = await vscode.workspace.openTextDocument(uri);
      const show = f.showEditor ?? true;
      if (show) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      return { filePath: f.filePath, success: true, message: show ? "File opened and displayed in editor" : "File opened in background" };
    } catch (err) {
      return { filePath: f.filePath, success: false, message: `Failed to open file: ${String(err)}` };
    }
  })),
});

export const renameSymbolHandler = async (params: { filePath: string; symbol: string; newName: string; codeSnippet?: string }, ctx: RequestContext) => {
  logger.info(`Renaming symbol "${params.symbol}" in ${params.filePath} to "${params.newName}"`);
  try {
    const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
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

async function revertSingleFile(filePath: string, workspaceRoot?: string): Promise<{ filePath: string; success: boolean; message: string }> {
  try {
    const uri = resolveFileUri(filePath, workspaceRoot);
    const diskBytes = await vscode.workspace.fs.readFile(uri);
    const diskContent = new TextDecoder().decode(diskBytes);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editorContent = doc.getText();

    if (editorContent === diskContent) {
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
      return { filePath, success: true, message: "Already in sync, triggered refresh" };
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

export const revertFilesHandler = async (params: { files: string[]; waitForDiagnostics?: boolean }, ctx: RequestContext) => {
  const uris = params.files.map((f) => resolveFileUri(f, ctx.workspaceFolder));
  const baseline = (params.waitForDiagnostics ?? false) ? snapshotDiagnosticCounts(uris) : undefined;
  const results = await Promise.all(params.files.map((f) => revertSingleFile(f, ctx.workspaceFolder)));
  if (baseline) await waitForDiagnosticsToChange(uris, baseline);
  return { results };
};

export const listWorkspacesHandler = async (_params: Record<string, never>, _ctx: RequestContext) => {
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
      extension_version: EXTENSION_VERSION,
      vscode_version: vscode.version,
      ide_type: ideType,
    }],
    summary: { total: 1, active: 1, available: 0, cleaned: 0 },
  };
};

// ══════════════════════════════════════════════════════════════════════
//                        NEW LSP HANDLERS
// ══════════════════════════════════════════════════════════════════════

export const getDocumentSymbolsHandler = async (params: { filePath: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
  if (!symbols || symbols.length === 0) return { symbols: [] };
  return { symbols: symbols.map(serializeDocumentSymbol) };
};

export const getDocumentHighlightsHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const pos = await resolveSymbolPosition(uri, params.symbol, params.codeSnippet);
  const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", uri, pos);
  if (!highlights || highlights.length === 0) return { highlights: [] };
  const kindMap: Record<number, "text" | "read" | "write"> = { 0: "text", 1: "read", 2: "write" };
  return {
    highlights: highlights.map((h) => ({
      range: serializeRange(h.range),
      kind: kindMap[h.kind ?? 0] || "text",
    })),
  };
};

export const getFoldingRangesHandler = async (params: { filePath: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", uri);
  if (!ranges || ranges.length === 0) return { ranges: [] };
  const kindMap: Record<number, "comment" | "imports" | "region"> = {
    1: "comment", 2: "imports", 3: "region",
  };
  return {
    ranges: ranges.map((r) => ({
      start: r.start,
      end: r.end,
      kind: r.kind !== undefined ? (kindMap[r.kind] || "other" as const) : ("other" as const),
    })),
  };
};

export const getSelectionRangesHandler = async (params: { filePath: string; positions: Array<{ line: number; character: number }> }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const positions = params.positions.map((p) => new vscode.Position(p.line, p.character));
  const ranges = await vscode.commands.executeCommand<vscode.SelectionRange[]>("vscode.executeSelectionRangeProvider", uri, positions);
  if (!ranges || ranges.length === 0) return { selectionRanges: [] };

  function serializeSelectionRange(sr: vscode.SelectionRange): { range: ReturnType<typeof serializeRange>; parent?: unknown } {
    const out: { range: ReturnType<typeof serializeRange>; parent?: unknown } = {
      range: serializeRange(sr.range),
    };
    if (sr.parent) out.parent = serializeSelectionRange(sr.parent);
    return out;
  }

  return { selectionRanges: ranges.map(serializeSelectionRange) };
};

export const getInlayHintsHandler = async (params: { filePath: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);

  const range = params.range
    ? new vscode.Range(
        new vscode.Position(params.range.start.line, params.range.start.character),
        new vscode.Position(params.range.end.line, params.range.end.character),
      )
    : await getFullDocumentRange(uri);

  const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>("vscode.executeInlayHintProvider", uri, range);
  if (!hints || hints.length === 0) return { hints: [] };
  const kindMap: Record<number, "type" | "parameter"> = { 1: "type", 2: "parameter" };

  return {
    hints: hints.map((h) => {
      const label = typeof h.label === "string" ? h.label : h.label.map((part) => part.value).join("");
      const tooltip = h.tooltip instanceof vscode.MarkdownString ? h.tooltip.value : typeof h.tooltip === "string" ? h.tooltip : undefined;
      const out: { position: { line: number; character: number }; label: string; kind?: "type" | "parameter" | "other"; paddingLeft?: boolean; paddingRight?: boolean; tooltip?: string } = {
        position: { line: h.position.line, character: h.position.character },
        label,
      };
      if (h.kind !== undefined) out.kind = kindMap[h.kind] || "other";
      if (h.paddingLeft) out.paddingLeft = true;
      if (h.paddingRight) out.paddingRight = true;
      if (tooltip) out.tooltip = tooltip;
      return out;
    }),
  };
};

export const getWorkspaceSymbolsHandler = async (params: { query: string }, _ctx: RequestContext) => {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", params.query);
  if (!symbols || symbols.length === 0) return { symbols: [] };
  return {
    symbols: symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      containerName: s.containerName || undefined,
      location: {
        uri: s.location.uri.toString(),
        range: serializeRange(s.location.range),
      },
    })),
  };
};

export const getDocumentLinksHandler = async (params: { filePath: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>("vscode.executeLinkProvider", uri);
  if (!links || links.length === 0) return { links: [] };
  return {
    links: links.map((l) => {
      const out: { range: ReturnType<typeof serializeRange>; target?: string; tooltip?: string } = {
        range: serializeRange(l.range),
      };
      if (l.target) out.target = l.target.toString();
      if (l.tooltip) out.tooltip = l.tooltip;
      return out;
    }),
  };
};

export const getCompletionsHandler = async (params: { filePath: string; line: number; character: number; triggerCharacter?: string; maxResults?: number }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const pos = new vscode.Position(params.line, params.character);
  const maxResults = params.maxResults ?? 50;

  const completions = params.triggerCharacter
    ? await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", uri, pos, params.triggerCharacter)
    : await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", uri, pos);

  if (!completions || !completions.items || completions.items.length === 0) return { items: [], isIncomplete: false };

  const items = completions.items.slice(0, maxResults).map((item) => {
    const doc = item.documentation instanceof vscode.MarkdownString
      ? item.documentation.value
      : typeof item.documentation === "string" ? item.documentation : undefined;
    const out: {
      label: string; kind?: string; detail?: string; documentation?: string;
      insertText?: string; sortText?: string; filterText?: string; preselect?: boolean;
    } = {
      label: typeof item.label === "string" ? item.label : item.label.label,
    };
    if (item.kind !== undefined) out.kind = COMPLETION_KIND_NAMES[item.kind] || "unknown";
    if (item.detail) out.detail = item.detail;
    if (doc) out.documentation = doc;
    if (item.insertText) out.insertText = typeof item.insertText === "string" ? item.insertText : item.insertText.value;
    if (item.sortText) out.sortText = item.sortText;
    if (item.filterText) out.filterText = item.filterText;
    if (item.preselect) out.preselect = true;
    return out;
  });

  return { items, isIncomplete: completions.isIncomplete };
};

export const getColorInformationHandler = async (params: { filePath: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const colors = await vscode.commands.executeCommand<vscode.ColorInformation[]>("vscode.executeDocumentColorProvider", uri);
  if (!colors || colors.length === 0) return { colors: [] };
  return {
    colors: colors.map((c) => ({
      range: serializeRange(c.range),
      color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha },
    })),
  };
};


export const getTypeHierarchyHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; direction?: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const pos = await resolveSymbolPosition(uri, params.symbol, params.codeSnippet);

  const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", uri, pos);
  if (!items || items.length === 0) throw new Error("Type hierarchy not available for this symbol (LSP returned no items)");
  const item = items[0];

  const serializeItem = (i: vscode.TypeHierarchyItem) => ({
    name: i.name,
    kind: i.kind,
    uri: i.uri.toString(),
    detail: i.detail || undefined,
    range: serializeRange(i.range),
  });

  const result: { supertypes?: unknown[]; subtypes?: unknown[] } = {};
  const dir = params.direction || "both";

  if (dir === "supertypes" || dir === "both") {
    const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", item);
    if (supertypes?.length) result.supertypes = supertypes.map(serializeItem);
  }

  if (dir === "subtypes" || dir === "both") {
    const subtypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSubtypes", item);
    if (subtypes?.length) result.subtypes = subtypes.map(serializeItem);
  }

  return result;
};

export const getCodeActionsHandler = async (params: { filePath: string; line: number; character: number; endLine?: number; endCharacter?: number; kind?: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const startPos = new vscode.Position(params.line, params.character);
  const endPos = new vscode.Position(params.endLine ?? params.line, params.endCharacter ?? params.character);
  const range = new vscode.Range(startPos, endPos);

  const raw = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
    params.kind ? vscode.CodeActionKind.Empty.append(params.kind) : undefined,
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

export const applyFixesHandler = async (params: { filePath: string; preferredOnly?: boolean }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
  await ensureDocumentOpen(uri);
  const preferredOnly = params.preferredOnly !== false; // default true

  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  const applied: string[] = [];
  let skipped = 0;

  // Strategy 1: fix diagnostics (errors/warnings with preferred quickfixes)
  const diags = vscode.languages.getDiagnostics(uri)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);

  const seen = new Set<string>();

  for (const diag of diags) {
    const key = `${diag.range.start.line}:${diag.range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let actions: vscode.CodeAction[];
    try {
      actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider", uri, diag.range,
      ) || [];
    } catch { actions = []; }
    const quickfixes = actions.filter(a => a.kind?.value?.startsWith("quickfix"));
    if (!quickfixes.length) { skipped++; continue; }

    const pick = preferredOnly
      ? quickfixes.find(a => a.isPreferred)
      : quickfixes.find(a => a.isPreferred) || quickfixes[0];

    if (!pick) { skipped++; continue; }

    try {
      if (pick.edit) await vscode.workspace.applyEdit(pick.edit);
      if (pick.command) await vscode.commands.executeCommand(pick.command.command, ...(pick.command.arguments || []));
      applied.push(pick.title);
    } catch (e) {
      logger.error(`Failed to apply fix "${pick.title}": ${e}`);
      skipped++;
    }
  }

  // Strategy 2: whole-file sweep for source.fixAll actions (catches issues
  // where diagnostics are stale but code actions are available)
  if (doc) {
    const fullRange = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
    try {
      const allActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider", uri, fullRange,
      ) || [];
      // Apply quickfixes we haven't already applied (preferred first, then
      // non-preferred non-copilot ones — catches rust-analyzer "Remove all
      // unused imports" which is quickfix but not always marked preferred)
      const remaining = allActions
        .filter(a =>
          a.kind?.value?.startsWith("quickfix") &&
          !a.kind?.value?.includes("copilot") &&
          !applied.includes(a.title),
        )
        .sort((a, b) => (b.isPreferred ? 1 : 0) - (a.isPreferred ? 1 : 0));
      for (const action of remaining) {
        try {
          if (action.edit) await vscode.workspace.applyEdit(action.edit);
          if (action.command) await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments || []));
          applied.push(action.title);
        } catch (e) {
          logger.error(`Failed to apply fix "${action.title}": ${e}`);
        }
      }
    } catch (e) {
      logger.error(`Whole-file sweep failed: ${e}`);
    }
  }

  // Save after all fixes
  if (applied.length > 0) await vscode.workspace.saveAll(false);
  return { applied, skipped };
};

export const getCallHierarchyHandler = async (params: { filePath: string; symbol: string; codeSnippet?: string; direction?: string }, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
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
