#!/usr/bin/env node
// Smart debug: LSP recon → identify suspicious lines → set breakpoints → inspect.
// LSP informs DAP — no guessing where to break.
//
// Usage: node smart-debug.mjs <type> <program> <file> [symbol]
//   type:    node, python, etc.
//   program: path to the program to debug
//   file:    file to investigate
//   symbol:  optional symbol to focus on (narrows breakpoint placement)
//
// Options:
//   --workspace <path>   — explicit workspace (default: auto-discover)
//   --eval "expr"        — evaluate expression when stopped (repeatable)
//   --depth N            — variable nesting depth (default: 1)

import { resolveSocket, callBridge, callMany } from "./lib.mjs";

// ── Parse args ───────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags = { workspace: null, evals: [], depth: 1 };
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--workspace" && rawArgs[i + 1]) { flags.workspace = rawArgs[++i]; }
  else if (rawArgs[i] === "--eval" && rawArgs[i + 1]) { flags.evals.push(rawArgs[++i]); }
  else if (rawArgs[i] === "--depth" && rawArgs[i + 1]) { flags.depth = parseInt(rawArgs[++i], 10); }
  else positional.push(rawArgs[i]);
}

const [type, program, file, symbol] = positional;

if (!type || !program || !file) {
  console.error("Usage: node smart-debug.mjs [--workspace <path>] <type> <program> <file> [symbol]");
  console.error("Options: --eval 'expr'  --depth N");
  process.exit(1);
}

const sock = resolveSocket(flags.workspace);

// ── Phase 0a: Auto-fix — resolve easy issues before debugging ────────

console.log("=== PHASE 0a: AUTO-FIX ===\n");

// Open file and sync from disk (ensures buffer matches disk content)
await callBridge(sock, "openFiles", { files: [{ filePath: file, showEditor: true }] }).catch(() => {});
await callBridge(sock, "revertFiles", { files: [file], waitForDiagnostics: true }).catch(() => {});
await new Promise(r => setTimeout(r, 500));

// Always attempt fixes — whole-file sweep catches issues even without diagnostics
const fixes = await callBridge(sock, "applyFixes", {
  filePath: file, preferredOnly: true,
}).catch(e => { console.log(`  applyFixes error: ${e.message}`); return { applied: [], skipped: 0 }; });

if (fixes.applied.length > 0) {
  for (const title of fixes.applied) console.log(`  Fixed: ${title}`);
  console.log(`Auto-fixed ${fixes.applied.length} issue(s). ${fixes.skipped} had no fix.`);
  await new Promise(r => setTimeout(r, 500)); // let LSP re-analyze after fixes
} else {
  console.log("No auto-fixable issues.");
}

// ── Phase 0b: LSP recon ─────────────────────────────────────────────

console.log("\n=== PHASE 0b: LSP RECON ===\n");

const recon = await callMany(sock, [
  ["diag", "getDiagnostics", { filePaths: [file], severities: ["error", "warning"], sources: [] }],
  ["outline", "getDocumentSymbols", { filePath: file }],
  ...(symbol ? [
    ["info", "getSymbolLSPInfo", { filePath: file, symbol, infoType: "all" }],
    ["refs", "getReferences", { filePath: file, symbol, usageCodeLineRange: 0 }],
    ["calls", "getCallHierarchy", { filePath: file, symbol, direction: "incoming" }],
  ] : []),
]);

// Print diagnostics
const diags = (recon.diag?.files || []).flatMap(f => f.diagnostics.map(d => ({
  line: d.range.start.line,
  severity: d.severity,
  message: d.message.split("\n")[0],
})));

if (diags.length) {
  console.log("Diagnostics:");
  for (const d of diags) console.log(`  Line ${d.line + 1}: [${d.severity}] ${d.message}`);
} else {
  console.log("No diagnostics.");
}

// ── Phase 1: Analyze — decide where to set breakpoints ──────────────

console.log("\n=== PHASE 1: BREAKPOINT ANALYSIS ===\n");

const breakpointLines = new Set();
const reasons = new Map(); // line -> reason

// Strategy 1: Break at diagnostic error lines
for (const d of diags) {
  if (d.severity === "error") {
    breakpointLines.add(d.line);
    reasons.set(d.line, `diagnostic: ${d.message}`);
  }
}

// Strategy 2: If symbol provided, break at incoming callers (where bad data originates)
const incoming = recon.calls?.incoming || [];
for (const call of incoming) {
  // Only break at callers in the same file
  if (call.from.uri.includes(file) || call.from.uri.endsWith(file.split("/").pop())) {
    const line = call.fromRanges?.[0]?.start?.line ?? call.from.range.start.line;
    breakpointLines.add(line);
    reasons.set(line, `caller: ${call.from.name} calls ${symbol}`);
  }
}

// Strategy 3: If symbol has references, break at reference sites in the same file
const refs = recon.refs?.locations || [];
for (const ref of refs) {
  if (ref.uri.includes(file) || ref.uri.endsWith(file.split("/").pop())) {
    breakpointLines.add(ref.range.start.line);
    reasons.set(ref.range.start.line, `reference to ${symbol}`);
  }
}

// Strategy 4: If symbol has a definition, break there
const defs = recon.info?.definition || [];
for (const def of defs) {
  if (def.uri.includes(file) || def.uri.endsWith(file.split("/").pop())) {
    breakpointLines.add(def.range.start.line);
    reasons.set(def.range.start.line, `definition of ${symbol}`);
  }
}

// Strategy 5: If no breakpoints yet, break at the symbol's outline entry
if (breakpointLines.size === 0 && symbol) {
  function findInOutline(syms) {
    for (const s of syms) {
      if (s.name === symbol) return s.range.start.line;
      if (s.children?.length) {
        const found = findInOutline(s.children);
        if (found !== null) return found;
      }
    }
    return null;
  }
  const outlineLine = findInOutline(recon.outline?.symbols || []);
  if (outlineLine !== null) {
    breakpointLines.add(outlineLine);
    reasons.set(outlineLine, `outline match for ${symbol}`);
  }
}

// Strategy 6: Last resort — no symbol, no diagnostics, break at first function
if (breakpointLines.size === 0) {
  const syms = recon.outline?.symbols || [];
  // Find first function-like symbol (kind 11 = function, 5 = method, 8 = constructor)
  for (const s of syms) {
    if ([5, 8, 11, 12].includes(s.kind)) {
      breakpointLines.add(s.range.start.line);
      reasons.set(s.range.start.line, `first function: ${s.name}`);
      break;
    }
  }
}

const sortedLines = [...breakpointLines].sort((a, b) => a - b);

if (sortedLines.length === 0) {
  console.log("Could not determine breakpoint locations. Use inspect.mjs with an explicit line.");
  process.exit(0);
}

for (const line of sortedLines) {
  console.log(`  Line ${line + 1}: ${reasons.get(line)}`);
}

// ── Phase 2: Set breakpoints + launch + inspect ─────────────────────

console.log(`\n=== PHASE 2: DEBUG (${sortedLines.length} breakpoint(s)) ===\n`);

// Helper
async function expandVars(variablesReference, currentDepth, maxDepth) {
  if (!variablesReference || currentDepth >= maxDepth) return null;
  try {
    const result = await callBridge(sock, "debugGetVariables", { variablesReference });
    const vars = result.variables || [];
    const expanded = [];
    for (const v of vars) {
      const entry = { name: v.name, value: v.value, type: v.type };
      if (v.variablesReference && currentDepth + 1 < maxDepth) {
        entry.children = await expandVars(v.variablesReference, currentDepth + 1, maxDepth);
      }
      expanded.push(entry);
    }
    return expanded;
  } catch { return null; }
}

function printVars(vars, indent = 4) {
  if (!vars) return;
  for (const v of vars) {
    const typeStr = v.type ? ` (${v.type})` : "";
    console.log(`${" ".repeat(indent)}${v.name} = ${v.value}${typeStr}`);
    if (v.children) printVars(v.children, indent + 2);
  }
}

try {
  // Set breakpoints
  const bps = sortedLines.map(line => ({ line }));
  await callBridge(sock, "debugSetBreakpoints", { filePath: file, breakpoints: bps });

  // Launch
  const launch = await callBridge(sock, "debugStart", { type, program });
  if (!launch.success) {
    console.error(`Failed to start: ${launch.error}`);
    process.exit(1);
  }
  console.log(`Session: ${launch.sessionName}`);

  // For each breakpoint hit, dump state then continue
  let hitCount = 0;
  const maxHits = sortedLines.length + 2; // safety limit

  while (hitCount < maxHits) {
    const event = await callBridge(sock, "debugWaitForEvent", { timeoutMs: 15000 });

    if (event.event === "terminated" || event.event === "timeout" || event.event === "noSession") {
      console.log(`\n--- ${event.event} ---`);
      break;
    }

    if (event.event === "stopped") {
      hitCount++;
      const reason = reasons.get((event.line || 1) - 1) || event.reason;
      console.log(`\n--- STOPPED #${hitCount}: Line ${event.line} (${reason}) ---`);

      // Stack trace
      const stack = await callBridge(sock, "debugGetStackTrace", {
        threadId: event.threadId || 0, startFrame: 0, levels: 5,
      });
      for (const f of stack.stackFrames.slice(0, 3)) {
        const src = f.source ? `${f.source}:${f.line}` : "<unknown>";
        console.log(`  #${f.id} ${f.name} at ${src}`);
      }

      // Variables
      const topFrame = stack.stackFrames[0];
      if (topFrame) {
        const scopes = await callBridge(sock, "debugGetScopes", { frameId: topFrame.id });
        for (const scope of scopes.scopes) {
          if (scope.expensive) continue;
          console.log(`\n  Variables (${scope.name}):`);
          const vars = await expandVars(scope.variablesReference, 0, flags.depth);
          printVars(vars);
        }

        // Evaluate
        if (flags.evals.length > 0) {
          console.log(`\n  Evaluate:`);
          for (const expr of flags.evals) {
            try {
              const result = await callBridge(sock, "debugEvaluate", {
                expression: expr, frameId: topFrame.id, context: "repl",
              });
              console.log(`    ${expr} → ${result.result} (${result.type})`);
            } catch (err) {
              console.log(`    ${expr} → Error: ${err.message}`);
            }
          }
        }
      }

      // Continue to next breakpoint
      await callBridge(sock, "debugContinue", {}).catch(() => {});
    }
  }

  // Cleanup
  await callBridge(sock, "debugStop", {}).catch(() => {});
  await callBridge(sock, "debugRemoveAllBreakpoints", {}).catch(() => {});
  console.log("\n=== SESSION STOPPED ===");

} catch (err) {
  console.error(`Error: ${err.message}`);
  await callBridge(sock, "debugStop", {}).catch(() => {});
  await callBridge(sock, "debugRemoveAllBreakpoints", {}).catch(() => {});
  process.exit(1);
}
