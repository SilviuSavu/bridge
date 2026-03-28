import * as vscode from "vscode";
import { logger } from "./logger";
import { resolveFileUri } from "./utils";
import type { RequestContext } from "./socket-server";
import type { DebugStateManager } from "./debug-manager";

let debugManager: DebugStateManager;

export function setDebugManager(manager: DebugStateManager): void {
  debugManager = manager;
}

// ── debugGetState ─────────────────────────────────────────────────────

export const debugGetStateHandler = async (_params: Record<string, never>, _ctx: RequestContext) => {
  return debugManager.getState();
};

// ── debugStart ────────────────────────────────────────────────────────

export const debugStartHandler = async (params: {
  name?: string;
  type?: string;
  request?: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  noDebug?: boolean;
}, ctx: RequestContext) => {
  // Build the launch config
  let config: vscode.DebugConfiguration;

  if (params.config) {
    // Full config object provided
    config = params.config as vscode.DebugConfiguration;
  } else {
    config = {
      type: params.type || "node",
      request: params.request || "launch",
      name: params.name || "Bridge Debug Session",
    };
    if (params.program) config.program = params.program;
    if (params.args) config.args = params.args;
    if (params.cwd) config.cwd = params.cwd;
    if (params.env) config.env = params.env;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.fsPath === ctx.workspaceFolder,
  ) || vscode.workspace.workspaceFolders?.[0];

  const started = await vscode.debug.startDebugging(
    workspaceFolder,
    config,
    { noDebug: params.noDebug ?? false },
  );

  if (!started) {
    return { success: false, error: "Failed to start debug session" };
  }

  // Wait briefly for the session to be assigned
  await new Promise((r) => setTimeout(r, 200));
  const session = vscode.debug.activeDebugSession;
  return {
    success: true,
    sessionId: session?.id,
    sessionName: session?.name,
  };
};

// ── debugStop ─────────────────────────────────────────────────────────

export const debugStopHandler = async (_params: Record<string, never>, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  await vscode.debug.stopDebugging(session);
  return { success: true };
};

// ── debugSetBreakpoints ───────────────────────────────────────────────

export const debugSetBreakpointsHandler = async (params: {
  filePath: string;
  breakpoints: Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }>;
}, ctx: RequestContext) => {
  const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);

  // Remove existing breakpoints for this file
  const existing = vscode.debug.breakpoints.filter(
    (bp) => bp instanceof vscode.SourceBreakpoint && bp.location.uri.toString() === uri.toString(),
  );
  if (existing.length > 0) {
    vscode.debug.removeBreakpoints(existing);
  }

  // Add new breakpoints
  const newBps = params.breakpoints.map((bp) => {
    const location = new vscode.Location(uri, new vscode.Position(bp.line, 0));
    return new vscode.SourceBreakpoint(
      location,
      true, // enabled
      bp.condition,
      bp.hitCondition,
      bp.logMessage,
    );
  });

  vscode.debug.addBreakpoints(newBps);

  return {
    breakpoints: params.breakpoints.map((bp) => ({
      line: bp.line,
      verified: true,
      condition: bp.condition,
    })),
  };
};

// ── debugGetBreakpoints ───────────────────────────────────────────────

export const debugGetBreakpointsHandler = async (params: { filePath?: string }, ctx: RequestContext) => {
  const filterUri = params.filePath ? resolveFileUri(params.filePath, ctx.workspaceFolder).toString() : null;

  const breakpoints = vscode.debug.breakpoints
    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
    .filter((bp) => !filterUri || bp.location.uri.toString() === filterUri)
    .map((bp) => ({
      filePath: bp.location.uri.fsPath,
      line: bp.location.range.start.line,
      enabled: bp.enabled,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
      logMessage: bp.logMessage,
    }));

  return { breakpoints };
};

// ── debugRemoveAllBreakpoints ─────────────────────────────────────────

export const debugRemoveAllBreakpointsHandler = async (params: { filePath?: string }, ctx: RequestContext) => {
  let toRemove: vscode.Breakpoint[];
  if (params.filePath) {
    const uri = resolveFileUri(params.filePath, ctx.workspaceFolder);
    toRemove = vscode.debug.breakpoints.filter(
      (bp) => bp instanceof vscode.SourceBreakpoint && bp.location.uri.toString() === uri.toString(),
    );
  } else {
    toRemove = [...vscode.debug.breakpoints];
  }
  if (toRemove.length > 0) vscode.debug.removeBreakpoints(toRemove);
  return { removed: toRemove.length };
};

// ── debugContinue ─────────────────────────────────────────────────────

export const debugContinueHandler = async (params: { threadId?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  const threadId = params.threadId ?? (await getFirstThreadId(session));
  debugManager.clearStopped();
  await session.customRequest("continue", { threadId });
  return { success: true };
};

// ── debugPause ────────────────────────────────────────────────────────

export const debugPauseHandler = async (params: { threadId?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  const threadId = params.threadId ?? (await getFirstThreadId(session));
  await session.customRequest("pause", { threadId });
  return { success: true };
};

// ── debugStepOver ─────────────────────────────────────────────────────

export const debugStepOverHandler = async (params: { threadId?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  const threadId = params.threadId ?? (await getFirstThreadId(session));
  debugManager.clearStopped();
  await session.customRequest("next", { threadId });
  return { success: true };
};

// ── debugStepInto ─────────────────────────────────────────────────────

export const debugStepIntoHandler = async (params: { threadId?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  const threadId = params.threadId ?? (await getFirstThreadId(session));
  debugManager.clearStopped();
  await session.customRequest("stepIn", { threadId });
  return { success: true };
};

// ── debugStepOut ──────────────────────────────────────────────────────

export const debugStepOutHandler = async (params: { threadId?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { success: false, error: "No active debug session" };
  const threadId = params.threadId ?? (await getFirstThreadId(session));
  debugManager.clearStopped();
  await session.customRequest("stepOut", { threadId });
  return { success: true };
};

// ── debugGetThreads ───────────────────────────────────────────────────

export const debugGetThreadsHandler = async (_params: Record<string, never>, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { threads: [] };
  const response = await session.customRequest("threads");
  return {
    threads: (response.threads || []).map((t: { id: number; name: string }) => ({
      id: t.id,
      name: t.name,
    })),
  };
};

// ── debugGetStackTrace ────────────────────────────────────────────────

export const debugGetStackTraceHandler = async (params: { threadId: number; startFrame?: number; levels?: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { stackFrames: [], totalFrames: 0 };
  const response = await session.customRequest("stackTrace", {
    threadId: params.threadId,
    startFrame: params.startFrame ?? 0,
    levels: params.levels ?? 20,
  });
  return {
    stackFrames: (response.stackFrames || []).map((f: {
      id: number; name: string; line: number; column: number; moduleId?: number;
      source?: { name?: string; path?: string };
    }) => ({
      id: f.id,
      name: f.name,
      source: f.source?.path || f.source?.name,
      line: f.line,
      column: f.column,
    })),
    totalFrames: response.totalFrames ?? response.stackFrames?.length ?? 0,
  };
};

// ── debugGetScopes ────────────────────────────────────────────────────

export const debugGetScopesHandler = async (params: { frameId: number }, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { scopes: [] };
  const response = await session.customRequest("scopes", { frameId: params.frameId });
  return {
    scopes: (response.scopes || []).map((s: {
      name: string; variablesReference: number; expensive: boolean;
      namedVariables?: number; indexedVariables?: number;
    }) => ({
      name: s.name,
      variablesReference: s.variablesReference,
      expensive: s.expensive,
      namedVariables: s.namedVariables,
      indexedVariables: s.indexedVariables,
    })),
  };
};

// ── debugGetVariables ─────────────────────────────────────────────────

export const debugGetVariablesHandler = async (params: {
  variablesReference: number;
  filter?: "indexed" | "named";
  start?: number;
  count?: number;
}, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { variables: [] };
  const req: Record<string, unknown> = { variablesReference: params.variablesReference };
  if (params.filter) req.filter = params.filter;
  if (params.start !== undefined) req.start = params.start;
  if (params.count !== undefined) req.count = params.count;
  const response = await session.customRequest("variables", req);
  return {
    variables: (response.variables || []).map((v: {
      name: string; value: string; type?: string; variablesReference: number;
      namedVariables?: number; indexedVariables?: number;
    }) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference,
      namedVariables: v.namedVariables,
      indexedVariables: v.indexedVariables,
    })),
  };
};

// ── debugEvaluate ─────────────────────────────────────────────────────

export const debugEvaluateHandler = async (params: {
  expression: string;
  frameId?: number;
  context?: "watch" | "repl" | "hover";
}, _ctx: RequestContext) => {
  const session = vscode.debug.activeDebugSession;
  if (!session) throw new Error("No active debug session");
  const req: Record<string, unknown> = {
    expression: params.expression,
    context: params.context || "repl",
  };
  if (params.frameId !== undefined) req.frameId = params.frameId;
  const response = await session.customRequest("evaluate", req);
  return {
    result: response.result,
    type: response.type,
    variablesReference: response.variablesReference || 0,
    namedVariables: response.namedVariables,
    indexedVariables: response.indexedVariables,
  };
};

// ── debugWaitForEvent ─────────────────────────────────────────────────

export const debugWaitForEventHandler = async (params: { timeoutMs?: number }, _ctx: RequestContext) => {
  const timeout = params.timeoutMs ?? 30000;
  return debugManager.waitForEvent(timeout);
};

// ── Helper ────────────────────────────────────────────────────────────

async function getFirstThreadId(session: vscode.DebugSession): Promise<number> {
  try {
    const response = await session.customRequest("threads");
    if (response.threads?.length > 0) return response.threads[0].id;
  } catch (e) {
    logger.error(`Failed to get threads: ${e}`);
  }
  return 1; // DAP default thread ID
}
