import * as vscode from "vscode";
import { logger } from "./logger";
import { getWorkspacePath } from "./utils";
import { SocketServer } from "./socket-server";
import { sleep, copyOpenedFilesPath, copyCurrentSelectionReference } from "./commands";
import * as schemas from "./schemas";
import * as handlers from "./handlers";

let server: SocketServer | undefined;

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

    // Register all RPC handlers
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

    await server.start();
    logger.info(`Socket server started at: ${server.getSocketPath()}`);
    logger.info(`Registered ${server.getServicesCount()} services`);

    // Register VS Code commands
    context.subscriptions.push(
      vscode.commands.registerCommand("vscode-mcp-bridge.sleep", (seconds: number) => sleep(seconds)),
      vscode.commands.registerCommand("vscode-mcp-bridge.copyOpenedFilesPath", (opts) => copyOpenedFilesPath(opts)),
      vscode.commands.registerCommand("vscode-mcp-bridge.copyCurrentSelectionReference", (opts) => copyCurrentSelectionReference(opts)),
      { dispose: () => { if (server) { server.cleanup(); server = undefined; } } },
    );
  } catch (err) {
    logger.error(`Failed to start socket server: ${err}`);
    vscode.window.showErrorMessage(`VSCode MCP Bridge: Failed to start socket server - ${err}`);
  }
}

export function deactivate(): void {
  logger.info("VSCode MCP Bridge extension is being deactivated");
  if (server) { server.cleanup(); server = undefined; }
  logger.dispose();
}
