import * as vscode from "vscode";

class Logger {
  private channel: vscode.OutputChannel | undefined;
  constructor(private name: string = "", private language: string = "log") {}

  private initChannel(): void {
    const title = "VSCode MCP Bridge";
    this.channel = vscode.window.createOutputChannel(`${title} ${this.name}`.trim(), this.language);
  }

  private output(message: string, level: string): void {
    if (!vscode.workspace.getConfiguration().get("vscode-mcp-bridge.enableLog")) return;
    if (!this.channel) this.initChannel();
    this.channel!.append(`[${level}] ${message}\n`);
  }

  private formatJson(value: unknown): string {
    try { return JSON.stringify(value, undefined, 2); }
    catch { return String(value); }
  }

  info(message: string): void { this.output(message, "INFO"); }
  error(message: string): void { this.output(message, "ERROR"); }

  logServiceCall(method: string, params: unknown, result: unknown): void {
    const ts = new Date().toISOString();
    const lines = [
      `[${method}] Service Call at ${ts}`,
      `Request: ${this.formatJson(params)}`,
      `Response: ${this.formatJson(result)}`,
      "---",
    ].join("\n");
    this.output(lines, "INFO");
  }

  logServiceError(method: string, params: unknown, error: unknown): void {
    const ts = new Date().toISOString();
    const lines = [
      `[${method}] Service Error at ${ts}`,
      `Request: ${this.formatJson(params)}`,
      `Error: ${String(error)}`,
      "---",
    ].join("\n");
    this.output(lines, "ERROR");
  }

  dispose(): void { this.channel?.dispose(); }
}

export const logger = new Logger();
