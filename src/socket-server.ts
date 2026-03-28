import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { logger } from "./logger";

export interface RequestContext {
  workspaceFolder: string;
}

interface ServiceDef {
  handler: (params: unknown, context: RequestContext) => Promise<unknown>;
  payloadSchema?: ZodType;
  resultSchema?: ZodType;
}

function getSocketDir(): string {
  const id = "YuTengjing.vscode-mcp";
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", id);
    case "win32":
      return "";
    default: {
      const slug = id.toLowerCase().replace(/\./g, "-");
      const dataHome =
        process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(dataHome, slug);
    }
  }
}

function computeSocketPath(workspacePath: string): string {
  const hash = crypto
    .createHash("md5")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 8);
  if (process.platform === "win32")
    return String.raw`\\.\pipe\vscode-mcp-${hash}`;
  return path.join(getSocketDir(), `vscode-mcp-${hash}.sock`);
}

export class SocketServer {
  private server: net.Server | undefined;
  private socketPath: string | undefined;
  private workspacePath: string;
  private services = new Map<string, ServiceDef>();

  private aliasServers: Array<{
    server: net.Server;
    socketPath: string;
    workspacePath: string;
  }> = [];

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.socketPath = computeSocketPath(workspacePath);
  }

  /** Create separate socket listeners for additional workspace folders so pi can connect from any folder. */
  addFolderAliases(folderPaths: string[]): void {
    if (process.platform === "win32") return;
    for (const folder of folderPaths) {
      const aliasPath = computeSocketPath(folder);
      if (aliasPath === this.socketPath) continue;
      if (this.aliasServers.some((a) => a.socketPath === aliasPath)) continue;
      try {
        if (fs.existsSync(aliasPath)) fs.unlinkSync(aliasPath);
        const aliasServer = net.createServer();
        aliasServer.on("connection", (socket) => {
          this.handleConnection(socket, folder);
        });
        aliasServer.on("error", (err) => {
          logger.error(`Alias server error for ${folder}: ${err}`);
        });
        aliasServer.listen(aliasPath, () => {
          logger.info(
            `Alias socket listening on: ${aliasPath} for workspace: ${folder}`,
          );
        });
        this.aliasServers.push({
          server: aliasServer,
          socketPath: aliasPath,
          workspacePath: folder,
        });
        logger.info(
          `Created alias listener: ${aliasPath} for workspace: ${folder}`,
        );
      } catch (err) {
        logger.error(`Failed to create alias listener for ${folder}: ${err}`);
      }
    }
  }

  /** Remove an alias socket listener. */
  removeFolderAlias(folderPath: string): void {
    const aliasPath = computeSocketPath(folderPath);
    const idx = this.aliasServers.findIndex((a) => a.socketPath === aliasPath);
    if (idx === -1) return;
    const alias = this.aliasServers[idx];
    try {
      alias.server.close();
      if (fs.existsSync(alias.socketPath)) fs.unlinkSync(alias.socketPath);
      logger.info(`Removed alias listener: ${alias.socketPath}`);
    } catch (err) {
      logger.error(`Failed to remove alias listener: ${err}`);
    }
    this.aliasServers.splice(idx, 1);
  }

  register(name: string, def: ServiceDef): void {
    this.services.set(name, def);
    logger.info(`Registered service: ${name}`);
  }

  private handleConnection(socket: net.Socket, workspaceFolder: string): void {
    logger.info(`Client connected for workspace: ${workspaceFolder}`);
    socket.on("data", (data: Buffer) => {
      this.handleSocketData(socket, data, workspaceFolder);
    });
    socket.on("close", () => {
      logger.info("Client disconnected");
    });
    socket.on("error", (err) => {
      logger.error(`Socket error: ${err}`);
    });
  }

  private async handleRequest(
    req: { id: string; method: string; params?: unknown },
    context: RequestContext,
  ): Promise<unknown> {
    const { id, method, params } = req;
    logger.info(
      `Processing request: ${method} (workspace: ${context.workspaceFolder})`,
    );
    const service = this.services.get(method);
    if (!service)
      return { id, error: { code: 404, message: `Unknown method: ${method}` } };

    try {
      let validatedParams: unknown = params || {};
      if (service.payloadSchema) {
        try {
          validatedParams = service.payloadSchema.parse(params || {});
        } catch (err) {
          return {
            id,
            error: {
              code: 400,
              message: `Invalid payload for ${method}`,
              details:
                err instanceof ZodError
                  ? err.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join(", ")
                  : String(err),
            },
          };
        }
      }

      const result = await service.handler(validatedParams, context);

      if (service.resultSchema) {
        try {
          service.resultSchema.parse(result);
        } catch (err) {
          logger.error(`Result validation failed for ${method}: ${err}`);
          return {
            id,
            error: {
              code: 500,
              message: `Invalid result from ${method}`,
              details:
                err instanceof ZodError
                  ? err.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join(", ")
                  : String(err),
            },
          };
        }
      }

      logger.logServiceCall(method, params, result);
      return { id, result };
    } catch (err) {
      logger.logServiceError(method, params, err);
      return {
        id,
        error: {
          code: 500,
          message: `Internal error in ${method}`,
          details: String(err),
        },
      };
    }
  }

  private async handleSocketData(
    socket: net.Socket,
    data: Buffer,
    workspaceFolder: string,
  ): Promise<void> {
    const context: RequestContext = { workspaceFolder };
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.id || !msg.method) {
        socket.write(
          JSON.stringify({
            id: msg.id || "unknown",
            error: {
              code: 400,
              message: "Invalid request format: missing id or method",
            },
          }),
        );
        return;
      }
      const response = await this.handleRequest(msg, context);
      socket.write(JSON.stringify(response));
      logger.info(`Sent response for ${msg.method}`);
    } catch (err) {
      logger.error(`Error handling socket data: ${err}`);
      socket.write(
        JSON.stringify({
          id: "unknown",
          error: {
            code: 500,
            message: "Internal server error",
            details: String(err),
          },
        }),
      );
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Socket server is already running");
    if (
      this.socketPath &&
      process.platform !== "win32" &&
      fs.existsSync(this.socketPath)
    ) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EBUSY" || e.code === "EADDRINUSE")
          throw new Error(
            "Socket is already in use by another VSCode instance",
            { cause: err },
          );
      }
    }
    return new Promise((resolve, reject) => {
      this.server = net.createServer();
      this.server.on("connection", (socket) => {
        this.handleConnection(socket, this.workspacePath);
      });
      this.server.on("error", (err) => {
        logger.error(`Server error: ${err}`);
        reject(err);
      });
      this.server.listen(this.socketPath, () => {
        logger.info(`Socket server listening on: ${this.socketPath}`);
        resolve();
      });
    });
  }

  cleanup(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      logger.info("Socket server closed");
    }
    if (
      this.socketPath &&
      process.platform !== "win32" &&
      fs.existsSync(this.socketPath)
    ) {
      try {
        fs.unlinkSync(this.socketPath);
        logger.info(`Socket file removed: ${this.socketPath}`);
      } catch (err) {
        logger.error(`Error removing socket: ${err}`);
      }
    }
    this.socketPath = undefined;
    // Clean up alias servers
    for (const alias of this.aliasServers) {
      try {
        alias.server.close();
        if (fs.existsSync(alias.socketPath)) {
          fs.unlinkSync(alias.socketPath);
          logger.info(`Alias socket removed: ${alias.socketPath}`);
        }
      } catch (err) {
        logger.error(`Error removing alias socket: ${err}`);
      }
    }
    this.aliasServers = [];
  }

  getSocketPath(): string | undefined {
    return this.socketPath;
  }
  getServicesCount(): number {
    return this.services.size;
  }
}
