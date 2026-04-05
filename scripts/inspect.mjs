#!/usr/bin/env node
// Debug inspect: set breakpoint → launch → wait → dump stack + variables → stop.
// One deterministic sequence. No steps to skip.
//
// Usage: node inspect.mjs <workspace> <type> <program> <file> <line>
//   type:    node, python, etc.
//   program: path to the program to debug
//   file:    file to set breakpoint in
//   line:    0-indexed line number for breakpoint
//
// Options:
//   --condition "expr"  — conditional breakpoint
//   --eval "expr"       — evaluate expression when stopped (repeatable)
//   --depth N           — variable nesting depth (default: 1)

import { resolveSocket, callBridge } from "./lib.mjs";

// ── Parse args ───────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags = { condition: null, evals: [], depth: 1, workspace: null };
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--condition" && rawArgs[i + 1]) { flags.condition = rawArgs[++i]; }
  else if (rawArgs[i] === "--eval" && rawArgs[i + 1]) { flags.evals.push(rawArgs[++i]); }
  else if (rawArgs[i] === "--depth" && rawArgs[i + 1]) { flags.depth = parseInt(rawArgs[++i], 10); }
  else if (rawArgs[i] === "--workspace" && rawArgs[i + 1]) { flags.workspace = rawArgs[++i]; }
  else positional.push(rawArgs[i]);
}

const [type, program, file, lineStr] = positional;
const line = parseInt(lineStr, 10);

if (!type || !program || !file || isNaN(line)) {
  console.error("Usage: node inspect.mjs [--workspace <path>] <type> <program> <file> <line>");
  console.error("Options: --condition 'expr'  --eval 'expr'  --depth N");
  console.error("         workspace defaults to auto-discovery if omitted");
  process.exit(1);
}

const sock = resolveSocket(flags.workspace);

// Open the file so VS Code is aware of it
await callBridge(sock, "openFiles", { files: [{ filePath: file, showEditor: false }] }).catch(() => {});

// ── Helper: recursively expand variables ─────────────────────────────

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

// ── Execute ──────────────────────────────────────────────────────────

try {
  // Step 1: Set breakpoint
  const bp = { line };
  if (flags.condition) bp.condition = flags.condition;
  const bpResult = await callBridge(sock, "debugSetBreakpoints", {
    filePath: file,
    breakpoints: [bp],
  });
  console.log(`=== BREAKPOINT ===`);
  for (const b of bpResult.breakpoints) {
    const cond = b.condition ? ` (condition: ${b.condition})` : "";
    console.log(`  Line ${b.line + 1}: ${b.verified ? "verified" : "pending"}${cond}`);
  }

  // Step 2: Launch
  const launch = await callBridge(sock, "debugStart", { type, program });
  if (!launch.success) {
    console.error(`\nFailed to start: ${launch.error}`);
    process.exit(1);
  }
  console.log(`\n=== SESSION STARTED ===`);
  console.log(`  ${launch.sessionName} (${launch.sessionId})`);

  // Step 3: Wait for stop
  const event = await callBridge(sock, "debugWaitForEvent", { timeoutMs: 30000 });
  console.log(`\n=== ${event.event.toUpperCase()} ===`);
  if (event.file) console.log(`  ${event.file}:${event.line}`);
  if (event.reason) console.log(`  Reason: ${event.reason}`);

  if (event.event !== "stopped") {
    console.log("\nProgram did not stop at breakpoint.");
    await callBridge(sock, "debugRemoveAllBreakpoints", {}).catch(() => {});
    process.exit(0);
  }

  // Step 4: Stack trace
  const stack = await callBridge(sock, "debugGetStackTrace", {
    threadId: event.threadId || 0,
    startFrame: 0,
    levels: 10,
  });
  console.log(`\n=== STACK TRACE ===`);
  for (const f of stack.stackFrames) {
    const src = f.source ? `${f.source}:${f.line}` : "<unknown>";
    console.log(`  #${f.id} ${f.name} at ${src}`);
  }

  // Step 5: Scopes + variables for top frame
  const topFrame = stack.stackFrames[0];
  if (topFrame) {
    const scopes = await callBridge(sock, "debugGetScopes", { frameId: topFrame.id });
    for (const scope of scopes.scopes) {
      if (scope.expensive) continue; // skip Global
      console.log(`\n=== VARIABLES (${scope.name}) ===`);
      const vars = await expandVars(scope.variablesReference, 0, flags.depth);
      printVars(vars);
    }
  }

  // Step 6: Evaluate expressions
  if (flags.evals.length > 0) {
    console.log(`\n=== EVALUATE ===`);
    for (const expr of flags.evals) {
      try {
        const result = await callBridge(sock, "debugEvaluate", {
          expression: expr,
          frameId: topFrame?.id,
          context: "repl",
        });
        const typeStr = result.type ? ` (${result.type})` : "";
        console.log(`  ${expr} → ${result.result}${typeStr}`);
      } catch (err) {
        console.log(`  ${expr} → Error: ${err.message}`);
      }
    }
  }

  // Step 7: Cleanup
  await callBridge(sock, "debugStop", {});
  await callBridge(sock, "debugRemoveAllBreakpoints", {}).catch(() => {});
  console.log(`\n=== SESSION STOPPED ===`);

} catch (err) {
  console.error(`Error: ${err.message}`);
  // Try cleanup
  await callBridge(sock, "debugStop", {}).catch(() => {});
  await callBridge(sock, "debugRemoveAllBreakpoints", {}).catch(() => {});
  process.exit(1);
}
