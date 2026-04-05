#!/usr/bin/env node
// Quick diagnostic check via the bridge socket. Used as a Claude Code hook.
// Usage: node check-diagnostics.mjs [workspace-path | auto]

import { resolveSocket, callBridge } from "./lib.mjs";

const sock = resolveSocket(process.argv[2]);

try {
  const result = await callBridge(sock, "getDiagnostics", {
    filePaths: [], severities: ["error", "warning"],
  });
  const files = result?.files || [];
  const issues = files.flatMap(f =>
    f.diagnostics.map(d => `${f.uri}:${d.range.start.line + 1}: [${d.severity}] ${d.message}`)
  );
  if (issues.length > 0) {
    console.log(`${issues.length} diagnostic(s) found:`);
    issues.slice(0, 20).forEach(i => console.log(i));
    if (issues.length > 20) console.log(`... and ${issues.length - 20} more`);
  }
} catch {
  // Silent fail if VS Code isn't running
}
