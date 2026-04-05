---
name: dap-debug
description: Use VS Code debugger (DAP) to set breakpoints, step through code, and inspect runtime state. Invoke when you need to understand runtime behavior, not just static types.
user_invocable: true
allowed-tools: Bash(bridge-smart-debug *), Bash(bridge-inspect *), Bash(bridge-recon *)
---

# Debug

## Smart debug (preferred — LSP-informed)

One command: auto-fix → LSP recon → analyze → set breakpoints at suspicious lines → launch → dump variables at each hit → stop.

```bash
# With a symbol to focus on (best results)
bridge-smart-debug <type> <program> <file> <symbol>

# Without a symbol (breaks at diagnostic errors or first function)
bridge-smart-debug <type> <program> <file>

# With expression evaluation
bridge-smart-debug node app.js app.js findUser --eval "typeof user" --eval "users.length"
```

The script automatically decides WHERE to break based on LSP analysis:
- Lines with type errors from diagnostics
- Callers that invoke the target symbol (where bad data originates)
- Reference sites of the symbol
- The symbol's definition
- Falls back to first function if nothing else found

## Manual inspect (when you know the exact line)

```bash
bridge-inspect <type> <program> <file> <line>
bridge-inspect node app.js app.js 15 --condition "user === undefined" --eval "users.length"
```

## For interactive stepping, use MCP tools directly

When you need to step through code line by line, fetch DAP tools via ToolSearch:

- `mcp__vscode-bridge__debugSetBreakpoints` + `debugStart` + `debugWaitForEvent`
- `mcp__vscode-bridge__debugStepOver` / `debugStepInto` / `debugStepOut`
- `mcp__vscode-bridge__debugGetVariables` + `debugEvaluate`
- `mcp__vscode-bridge__debugContinue` + `debugStop`

## When to use debug (not just LSP)

- Bug depends on runtime data (what value a variable actually has)
- Dynamic language where static types aren't available
- Need to trace actual execution path
- Want to inspect state without modifying code
