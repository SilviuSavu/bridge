// Shared socket utilities for bridge scripts
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getSocketDir() {
  const id = "YuTengjing.vscode-mcp";
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", id);
  const slug = id.toLowerCase().replace(/\./g, "-");
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, slug);
}

export function computeSocketPath(workspacePath) {
  const hash = crypto.createHash("md5").update(workspacePath).digest("hex").slice(0, 8);
  if (process.platform === "win32") return `\\\\.\\pipe\\vscode-mcp-${hash}`;
  return path.join(getSocketDir(), `vscode-mcp-${hash}.sock`);
}

// Scan for available socket files, sorted by most recently modified
export function discoverSockets() {
  const dir = getSocketDir();
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".sock"))
    .map(f => {
      const full = path.join(dir, f);
      try { return { path: full, mtime: fs.statSync(full).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .map(s => s.path);
}

// Resolve to a socket path: explicit workspace > auto-discover > cwd fallback
export function resolveSocket(workspaceArg) {
  if (workspaceArg && workspaceArg !== "auto") {
    return computeSocketPath(path.resolve(workspaceArg));
  }
  const sockets = discoverSockets();
  if (sockets.length > 0) return sockets[0];
  return computeSocketPath(process.cwd());
}

export function callBridge(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };

    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify({ id: "1", method, params: params || {} }));
    });

    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      try {
        const resp = JSON.parse(buf);
        client.end();
        if (resp.error) settle(reject, new Error(resp.error.message || JSON.stringify(resp.error)));
        else settle(resolve, resp.result);
      } catch { /* incomplete */ }
    });

    client.on("error", (err) => settle(reject, err));
    client.on("close", () => {
      if (!settled) {
        try {
          const resp = JSON.parse(buf);
          if (resp.error) settle(reject, new Error(resp.error.message));
          else settle(resolve, resp.result);
        } catch { settle(reject, new Error("Connection closed without response")); }
      }
    });

    setTimeout(() => { client.destroy(); settle(reject, new Error("Timeout")); }, 30000);
  });
}

// Run multiple bridge calls in sequence, collecting results
export async function callMany(socketPath, calls) {
  const results = {};
  for (const [key, method, params] of calls) {
    try {
      results[key] = await callBridge(socketPath, method, params);
    } catch (err) {
      results[key] = { _error: err.message };
    }
  }
  return results;
}
