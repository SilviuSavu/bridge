import * as vscode from "vscode";
import { logger } from "./logger";
import { getWorkspacePath } from "./utils";
import { SocketServer } from "./socket-server";
import { sleep, copyOpenedFilesPath, copyCurrentSelectionReference } from "./commands";
import * as schemas from "./schemas";
import * as handlers from "./handlers";
import * as debugHandlers from "./debug-handlers";
import { DebugStateManager } from "./debug-manager";

let server: SocketServer | undefined;
let debugManager: DebugStateManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.info("VSCode MCP Bridge extension is being activated");

  const workspace = getWorkspacePath();
  if (!workspace) {
    logger.info("No workspace folder found, extension will not start socket server");
    return;
  }
  logger.info(`Current workspace: ${workspace}`);

  try {
    server = new SocketServer(workspace);

    // Initialize debug manager
    debugManager = new DebugStateManager();
    debugHandlers.setDebugManager(debugManager);

    // Register all RPC handlers — original
    server.register("health", { handler: handlers.healthHandler, payloadSchema: schemas.healthPayload, resultSchema: schemas.healthResult });
    server.register("getDiagnostics", { handler: handlers.getDiagnosticsHandler, payloadSchema: schemas.getDiagnosticsPayload, resultSchema: schemas.getDiagnosticsResult });
    server.register("getSymbolLSPInfo", { handler: handlers.getSymbolLSPInfoHandler, payloadSchema: schemas.getSymbolLSPInfoPayload, resultSchema: schemas.getSymbolLSPInfoResult });
    server.register("getReferences", { handler: handlers.getReferencesHandler, payloadSchema: schemas.getReferencesPayload, resultSchema: schemas.getReferencesResult });
    server.register("executeCommand", { handler: handlers.executeCommandHandler, payloadSchema: schemas.executeCommandPayload, resultSchema: schemas.executeCommandResult });
    server.register("openFiles", { handler: handlers.openFilesHandler, payloadSchema: schemas.openFilesPayload, resultSchema: schemas.openFilesResult });
    server.register("renameSymbol", { handler: handlers.renameSymbolHandler, payloadSchema: schemas.renameSymbolPayload, resultSchema: schemas.renameSymbolResult });
    server.register("revertFiles", { handler: handlers.revertFilesHandler, payloadSchema: schemas.revertFilesPayload, resultSchema: schemas.revertFilesResult });
    server.register("listWorkspaces", { handler: handlers.listWorkspacesHandler, resultSchema: schemas.listWorkspacesResult });
    server.register("getCodeActions", { handler: handlers.getCodeActionsHandler, payloadSchema: schemas.getCodeActionsPayload, resultSchema: schemas.getCodeActionsResult });
    server.register("getCallHierarchy", { handler: handlers.getCallHierarchyHandler, payloadSchema: schemas.getCallHierarchyPayload, resultSchema: schemas.getCallHierarchyResult });

    // Register all RPC handlers — new LSP capabilities
    server.register("getDocumentSymbols", { handler: handlers.getDocumentSymbolsHandler, payloadSchema: schemas.getDocumentSymbolsPayload, resultSchema: schemas.getDocumentSymbolsResult });
    server.register("getDocumentHighlights", { handler: handlers.getDocumentHighlightsHandler, payloadSchema: schemas.getDocumentHighlightsPayload, resultSchema: schemas.getDocumentHighlightsResult });
    server.register("getFoldingRanges", { handler: handlers.getFoldingRangesHandler, payloadSchema: schemas.getFoldingRangesPayload, resultSchema: schemas.getFoldingRangesResult });
    server.register("getSelectionRanges", { handler: handlers.getSelectionRangesHandler, payloadSchema: schemas.getSelectionRangesPayload, resultSchema: schemas.getSelectionRangesResult });
    server.register("getInlayHints", { handler: handlers.getInlayHintsHandler, payloadSchema: schemas.getInlayHintsPayload, resultSchema: schemas.getInlayHintsResult });
    server.register("getWorkspaceSymbols", { handler: handlers.getWorkspaceSymbolsHandler, payloadSchema: schemas.getWorkspaceSymbolsPayload, resultSchema: schemas.getWorkspaceSymbolsResult });
    server.register("getDocumentLinks", { handler: handlers.getDocumentLinksHandler, payloadSchema: schemas.getDocumentLinksPayload, resultSchema: schemas.getDocumentLinksResult });
    server.register("getCompletions", { handler: handlers.getCompletionsHandler, payloadSchema: schemas.getCompletionsPayload, resultSchema: schemas.getCompletionsResult });
    server.register("getColorInformation", { handler: handlers.getColorInformationHandler, payloadSchema: schemas.getColorInformationPayload, resultSchema: schemas.getColorInformationResult });
    server.register("getTypeHierarchy", { handler: handlers.getTypeHierarchyHandler, payloadSchema: schemas.getTypeHierarchyPayload, resultSchema: schemas.getTypeHierarchyResult });

    // Register all RPC handlers — debug (DAP)
    server.register("debugGetState", { handler: debugHandlers.debugGetStateHandler, payloadSchema: schemas.debugGetStatePayload, resultSchema: schemas.debugGetStateResult });
    server.register("debugStart", { handler: debugHandlers.debugStartHandler, payloadSchema: schemas.debugStartPayload, resultSchema: schemas.debugStartResult });
    server.register("debugStop", { handler: debugHandlers.debugStopHandler, payloadSchema: schemas.debugStopPayload, resultSchema: schemas.debugStopResult });
    server.register("debugSetBreakpoints", { handler: debugHandlers.debugSetBreakpointsHandler, payloadSchema: schemas.debugSetBreakpointsPayload, resultSchema: schemas.debugSetBreakpointsResult });
    server.register("debugGetBreakpoints", { handler: debugHandlers.debugGetBreakpointsHandler, payloadSchema: schemas.debugGetBreakpointsPayload, resultSchema: schemas.debugGetBreakpointsResult });
    server.register("debugRemoveAllBreakpoints", { handler: debugHandlers.debugRemoveAllBreakpointsHandler, payloadSchema: schemas.debugRemoveAllBreakpointsPayload, resultSchema: schemas.debugRemoveAllBreakpointsResult });
    server.register("debugContinue", { handler: debugHandlers.debugContinueHandler, payloadSchema: schemas.debugThreadActionPayload, resultSchema: schemas.debugThreadActionResult });
    server.register("debugPause", { handler: debugHandlers.debugPauseHandler, payloadSchema: schemas.debugThreadActionPayload, resultSchema: schemas.debugThreadActionResult });
    server.register("debugStepOver", { handler: debugHandlers.debugStepOverHandler, payloadSchema: schemas.debugThreadActionPayload, resultSchema: schemas.debugThreadActionResult });
    server.register("debugStepInto", { handler: debugHandlers.debugStepIntoHandler, payloadSchema: schemas.debugThreadActionPayload, resultSchema: schemas.debugThreadActionResult });
    server.register("debugStepOut", { handler: debugHandlers.debugStepOutHandler, payloadSchema: schemas.debugThreadActionPayload, resultSchema: schemas.debugThreadActionResult });
    server.register("debugGetThreads", { handler: debugHandlers.debugGetThreadsHandler, payloadSchema: schemas.debugGetThreadsPayload, resultSchema: schemas.debugGetThreadsResult });
    server.register("debugGetStackTrace", { handler: debugHandlers.debugGetStackTraceHandler, payloadSchema: schemas.debugGetStackTracePayload, resultSchema: schemas.debugGetStackTraceResult });
    server.register("debugGetScopes", { handler: debugHandlers.debugGetScopesHandler, payloadSchema: schemas.debugGetScopesPayload, resultSchema: schemas.debugGetScopesResult });
    server.register("debugGetVariables", { handler: debugHandlers.debugGetVariablesHandler, payloadSchema: schemas.debugGetVariablesPayload, resultSchema: schemas.debugGetVariablesResult });
    server.register("debugEvaluate", { handler: debugHandlers.debugEvaluateHandler, payloadSchema: schemas.debugEvaluatePayload, resultSchema: schemas.debugEvaluateResult });
    server.register("debugWaitForEvent", { handler: debugHandlers.debugWaitForEventHandler, payloadSchema: schemas.debugWaitForEventPayload, resultSchema: schemas.debugWaitForEventResult });

    await server.start();
    logger.info(`Socket server started at: ${server.getSocketPath()}`);
    logger.info(`Registered ${server.getServicesCount()} services`);

    // Create socket aliases for all other workspace folders
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 1) {
      const otherFolders = folders.slice(1).map((f) => f.uri.fsPath);
      server.addFolderAliases(otherFolders);
    }

    // React to workspace folder changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        if (!server) return;
        for (const added of e.added) {
          server.addFolderAliases([added.uri.fsPath]);
        }
        for (const removed of e.removed) {
          server.removeFolderAlias(removed.uri.fsPath);
        }
      }),
    );

    // Register VS Code commands
    context.subscriptions.push(
      vscode.commands.registerCommand("vscode-mcp-bridge.sleep", (seconds: number) => sleep(seconds)),
      vscode.commands.registerCommand("vscode-mcp-bridge.copyOpenedFilesPath", (opts) => copyOpenedFilesPath(opts)),
      vscode.commands.registerCommand("vscode-mcp-bridge.copyCurrentSelectionReference", (opts) => copyCurrentSelectionReference(opts)),
      { dispose: () => { if (server) { server.cleanup(); server = undefined; } if (debugManager) { debugManager.dispose(); debugManager = undefined; } } },
    );
  } catch (err) {
    logger.error(`Failed to start socket server: ${err}`);
    vscode.window.showErrorMessage(`VSCode MCP Bridge: Failed to start socket server - ${err}`);
  }
}

export function deactivate(): void {
  logger.info("VSCode MCP Bridge extension is being deactivated");
  if (debugManager) { debugManager.dispose(); debugManager = undefined; }
  if (server) { server.cleanup(); server = undefined; }
  logger.dispose();
}
