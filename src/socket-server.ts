import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { logger } from "./logger";

interface ServiceDef {
  handler: (params: unknown) => Promise<unknown>;
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
      const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(dataHome, slug);
    }
  }
}

function computeSocketPath(workspacePath: string): string {
  const hash = crypto.createHash("md5").update(workspacePath).digest("hex").slice(0, 8);
  if (process.platform === "win32") return String.raw`\\.\pipe\vscode-mcp-${hash}`;
  return path.join(getSocketDir(), `vscode-mcp-${hash}.sock`);
}

export class SocketServer {
  private server: net.Server | undefined;
  private socketPath: string | undefined;
  private services = new Map<string, ServiceDef>();

  constructor(workspacePath: string) {
    this.socketPath = computeSocketPath(workspacePath);
  }

  register(name: string, def: ServiceDef): void {
    this.services.set(name, def);
    logger.info(`Registered service: ${name}`);
  }

  private async handleRequest(req: { id: string; method: string; params?: unknown }): Promise<unknown> {
    const { id, method, params } = req;
    logger.info(`Processing request: ${method}`);
    const service = this.services.get(method);
    if (!service) return { id, error: { code: 404, message: `Unknown method: ${method}` } };

    try {
      let validatedParams = params || {};
      if (service.payloadSchema) {
        try { validatedParams = service.payloadSchema.parse(params || {}); }
        catch (err) {
          return { id, error: { code: 400, message: `Invalid payload for ${method}`, details: err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") : String(err) } };
        }
      }

      const result = await service.handler(validatedParams);

      if (service.resultSchema) {
        try { service.resultSchema.parse(result); }
        catch (err) {
          logger.error(`Result validation failed for ${method}: ${err}`);
          return { id, error: { code: 500, message: `Invalid result from ${method}`, details: err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") : String(err) } };
        }
      }

      logger.logServiceCall(method, params, result);
      return { id, result };
    } catch (err) {
      logger.logServiceError(method, params, err);
      return { id, error: { code: 500, message: `Internal error in ${method}`, details: String(err) } };
    }
  }

  private async handleSocketData(socket: net.Socket, data: Buffer): Promise<void> {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.id || !msg.method) {
        socket.write(JSON.stringify({ id: msg.id || "unknown", error: { code: 400, message: "Invalid request format: missing id or method" } }));
        return;
      }
      const response = await this.handleRequest(msg);
      socket.write(JSON.stringify(response));
      logger.info(`Sent response for ${msg.method}`);
    } catch (err) {
      logger.error(`Error handling socket data: ${err}`);
      socket.write(JSON.stringify({ id: "unknown", error: { code: 500, message: "Internal server error", details: String(err) } }));
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Socket server is already running");
    if (this.socketPath && process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EBUSY" || e.code === "EADDRINUSE") throw new Error("Socket is already in use by another VSCode instance", { cause: err });
      }
    }
    return new Promise((resolve, reject) => {
      this.server = net.createServer();
      this.server.on("connection", (socket) => {
        logger.info(`Client connected to socket: ${this.socketPath}`);
        socket.on("data", (data) => { this.handleSocketData(socket, data); });
        socket.on("close", () => { logger.info("Client disconnected"); });
        socket.on("error", (err) => { logger.error(`Socket error: ${err}`); });
      });
      this.server.on("error", (err) => { logger.error(`Server error: ${err}`); reject(err); });
      this.server.listen(this.socketPath, () => { logger.info(`Socket server listening on: ${this.socketPath}`); resolve(); });
    });
  }

  cleanup(): void {
    if (this.server) { this.server.close(); this.server = undefined; logger.info("Socket server closed"); }
    if (this.socketPath && process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); logger.info(`Socket file removed: ${this.socketPath}`); } catch (err) { logger.error(`Error removing socket: ${err}`); }
    }
    this.socketPath = undefined;
  }

  getSocketPath(): string | undefined { return this.socketPath; }
  getServicesCount(): number { return this.services.size; }
}
