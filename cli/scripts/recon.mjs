#!/usr/bin/env node
// LSP recon: diagnostics + symbol info + references + call hierarchy in one shot.
// Usage: node recon.mjs <workspace> <file> [symbol]
//
// With just a file: returns diagnostics + document symbols (outline)
// With a symbol:    adds type info, references, call hierarchy

import { resolveSocket, callBridge, callMany } from "./lib.mjs";

const args = process.argv.slice(2);
// First arg is workspace OR file (if auto-discovery)
// Detect: if first arg looks like a file path with extension, treat as file and auto-discover
let workspace, file, symbol;
if (args.length >= 2 && !args[0].match(/\.\w+$/)) {
  [workspace, file, symbol] = args;
} else {
  [file, symbol] = args;
  workspace = "auto";
}

if (!file) {
  console.error("Usage: node recon.mjs [workspace] <file> [symbol]");
  console.error("       workspace defaults to auto-discovery if omitted");
  process.exit(1);
}

const sock = resolveSocket(workspace);

// ── Open file first so LSP has it analyzed ───────────────────────────

await callBridge(sock, "openFiles", { files: [{ filePath: file, showEditor: false }] }).catch(() => {});
// Brief pause to let the language server analyze
await new Promise(r => setTimeout(r, 500));

// ── Always: diagnostics + outline ────────────────────────────────────

const base = await callMany(sock, [
  ["diag", "getDiagnostics", { filePaths: [file], severities: ["error", "warning"], sources: [] }],
  ["outline", "getDocumentSymbols", { filePath: file }],
]);

// ── Diagnostics ──────────────────────────────────────────────────────

const files = base.diag?.files || [];
const allDiags = files.flatMap(f => f.diagnostics.map(d => ({
  line: d.range.start.line + 1,
  severity: d.severity,
  message: d.message.split("\n")[0],
  source: d.source,
})));

console.log(`=== DIAGNOSTICS (${file}) ===`);
if (allDiags.length === 0) {
  console.log("No errors or warnings.");
} else {
  for (const d of allDiags) {
    console.log(`  Line ${d.line}: [${d.severity}] ${d.message} (${d.source})`);
  }
}

// ── Outline ──────────────────────────────────────────────────────────

function printSymbols(syms, indent = 2) {
  for (const s of syms) {
    const line = s.range.start.line + 1;
    const detail = s.detail ? ` — ${s.detail}` : "";
    console.log(`${" ".repeat(indent)}Line ${line}: ${s.name}${detail}`);
    if (s.children?.length) printSymbols(s.children, indent + 2);
  }
}

console.log(`\n=== OUTLINE ===`);
if (base.outline?.symbols?.length) {
  printSymbols(base.outline.symbols);
} else {
  console.log("  No symbols found.");
}

// ── Symbol-specific recon ────────────────────────────────────────────

if (symbol) {
  const symResults = await callMany(sock, [
    ["info", "getSymbolLSPInfo", { filePath: file, symbol, infoType: "all" }],
    ["refs", "getReferences", { filePath: file, symbol, usageCodeLineRange: 2 }],
    ["calls", "getCallHierarchy", { filePath: file, symbol, direction: "both" }],
  ]);

  // Type info
  console.log(`\n=== SYMBOL: ${symbol} ===`);
  const hover = symResults.info?.hover;
  if (hover?.length) {
    const contents = hover.map(h => Array.isArray(h.contents) ? h.contents.join("\n") : h.contents);
    for (const c of contents) console.log(`  ${c}`);
  } else if (symResults.info?._error) {
    console.log(`  Error: ${symResults.info._error}`);
  } else {
    console.log("  No hover info.");
  }

  // Definitions
  const defs = symResults.info?.definition || [];
  if (defs.length) {
    console.log(`\n=== DEFINITION ===`);
    for (const d of defs) {
      const loc = `${d.uri}:${d.range.start.line + 1}`;
      console.log(`  ${loc}`);
    }
  }

  // References
  const refs = symResults.refs?.locations || [];
  console.log(`\n=== REFERENCES (${refs.length}) ===`);
  for (const r of refs.slice(0, 15)) {
    const loc = `${r.uri}:${r.range.start.line + 1}`;
    const code = r.usageCode ? `\n    ${r.usageCode.split("\n").join("\n    ")}` : "";
    console.log(`  ${loc}${code}`);
  }
  if (refs.length > 15) console.log(`  ... and ${refs.length - 15} more`);

  // Call hierarchy
  const incoming = symResults.calls?.incoming || [];
  const outgoing = symResults.calls?.outgoing || [];
  if (incoming.length || outgoing.length) {
    console.log(`\n=== CALL HIERARCHY ===`);
    if (incoming.length) {
      console.log("  Incoming (who calls this):");
      for (const c of incoming) {
        console.log(`    ${c.from.name} at ${c.from.uri}:${c.from.range.start.line + 1}`);
      }
    }
    if (outgoing.length) {
      console.log("  Outgoing (what this calls):");
      for (const c of outgoing) {
        console.log(`    ${c.to.name} at ${c.to.uri}:${c.to.range.start.line + 1}`);
      }
    }
  }
}
