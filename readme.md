# VSCode MCP Bridge

Bridge between VS Code language servers and MCP clients over Unix socket. Enables AI/code assistants to leverage VS Code's built-in LSP and DAP capabilities.

## Architecture

```
                          Unix Socket (JSON-RPC)
┌─────────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  MCP Client     │ ←→   │  Socket Server   │ ←→   │  VS Code LSP/DAP  │
│  (Claude Code)  │      │  (Extension)     │      │  Language Servers  │
└─────────────────┘      └──────────────────┘      └────────────────────┘
        │
        ├── bridge-recon         (LSP recon: diagnostics, symbols, refs, calls)
        ├── bridge-smart-debug   (auto-fix → recon → breakpoint → inspect)
        ├── bridge-inspect       (manual breakpoint + variable dump)
        └── bridge-diagnostics   (hook: auto-check after edits)
```

## Installation

### 1. Install the VS Code extension

```bash
code --install-extension vscode-mcp-bridge-4.7.0.vsix
```

### 2. Install the CLI tools

```bash
cd cli && npm link
```

This creates the following commands in your PATH:

| Command | Description |
|---------|-------------|
| `bridge-recon` | LSP recon: diagnostics + outline, optionally type info + refs + call hierarchy |
| `bridge-smart-debug` | Full debug pipeline: auto-fix → recon → breakpoint analysis → launch → inspect |
| `bridge-inspect` | Manual debug: set breakpoint at a specific line, launch, dump variables |
| `bridge-diagnostics` | Quick diagnostic check (designed as a Claude Code hook) |
| `vscode-bridge-mcp` | Standalone MCP stdio server |

### 3. Set up the Claude Code hook (auto-diagnostics after edits)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bridge-diagnostics auto",
            "timeout": 15,
            "statusMessage": "Checking diagnostics..."
          }
        ]
      }
    ]
  }
}
```

This runs `bridge-diagnostics` automatically after every `Edit` or `Write` tool use, surfacing LSP errors and warnings inline without manual checking.

### 4. Install the Claude Code skills (optional)

Copy the skill definitions to your Claude Code skills directory:

```bash
# LSP skill — /lsp command for recon before edits
mkdir -p ~/.claude/skills/lsp
cp cli/SKILL-lsp.md ~/.claude/skills/lsp/SKILL.md

# DAP debug skill — /dap-debug command for runtime debugging
mkdir -p ~/.claude/skills/dap-debug
cp cli/SKILL.md ~/.claude/skills/dap-debug/SKILL.md
```

---

## CLI Scripts

### bridge-smart-debug

Full debug pipeline: auto-fix → LSP recon → breakpoint analysis → launch → inspect.

```bash
# With a symbol to focus on (best results)
bridge-smart-debug <type> <program> <file> <symbol>

# Without a symbol (breaks at diagnostic errors or first function)
bridge-smart-debug <type> <program> <file>

# With expression evaluation
bridge-smart-debug node app.js app.js findUser --eval "typeof user" --eval "users.length"

# Rust with LLDB
bridge-smart-debug lldb target/debug/myapp src/main.rs process_order
```

**Phases:**

1. **Phase 0a: Auto-fix** — Calls `applyFixes` to resolve auto-fixable issues (unused imports, lint errors) before debugging. Uses two strategies: diagnostic-targeted fixes and a whole-file sweep for preferred quickfixes.
2. **Phase 0b: LSP Recon** — Fetches diagnostics, document outline, type info, references, and call hierarchy.
3. **Phase 1: Breakpoint Analysis** — LSP-informed breakpoint placement at diagnostic errors, incoming callers, reference sites, symbol definitions, or first function (fallback).
4. **Phase 2: Debug** — Sets breakpoints, launches the program, dumps stack trace + variables at each hit, then stops.

### bridge-recon

LSP reconnaissance in one shot.

```bash
# File only — diagnostics + outline
bridge-recon <file>

# File + symbol — adds type info, references, call hierarchy
bridge-recon <file> <symbol>
```

### bridge-inspect

Manual debug at a specific line.

```bash
bridge-inspect <type> <program> <file> <line>
bridge-inspect node app.js app.js 15 --condition "user === undefined" --eval "users.length"
```

### bridge-diagnostics

Quick diagnostic check. Designed as a Claude Code hook but can be run standalone.

```bash
bridge-diagnostics          # check all open files
bridge-diagnostics auto     # auto-discover VS Code socket
```

---

## Supported Operations

### Language Features (LSP)

| Method | Description |
|--------|-------------|
| `health` | Extension health check with system info, IDE type detection |
| `getDiagnostics` | Fetch diagnostics with filtering by source and severity |
| `getSymbolLSPInfo` | Hover, signature help, definitions, implementations for a symbol |
| `getReferences` | Find all references to a symbol |
| `renameSymbol` | Rename symbol with automatic multi-file updates |
| `revertFiles` | Revert edited files back to disk state |
| `openFiles` | Open files in editor or background |
| `listWorkspaces` | List workspace folders with metadata |
| `executeCommand` | Run arbitrary VS Code commands |
| `getDocumentSymbols` | Document outline symbols (classes, functions, etc.) |
| `getDocumentHighlights` | Highlight all occurrences of a symbol |
| `getFoldingRanges` | Folding regions in a document |
| `getSelectionRanges` | Smart selection ranges for documents |
| `getInlayHints` | Inline hints (type annotations, parameter hints) |
| `getWorkspaceSymbols` | Search workspace symbols globally |
| `getDocumentLinks` | Links detected in documents (URLs, references) |
| `getCompletions` | Autocomplete suggestions at a position |
| `getColorInformation` | Color information for color picker support |
| `getTypeHierarchy` | Supertypes/subtypes for type hierarchy navigation |

### Code Actions

| Method | Description |
|--------|-------------|
| `getCodeActions` | Get quick-fixes and refactorings at a cursor position |
| `applyFixes` | Programmatically apply preferred quickfixes for a file |
| `getCallHierarchy` | Get incoming/outgoing calls for a function/method |

`applyFixes` uses two strategies:
1. **Diagnostic-targeted** — Gets code actions at each diagnostic range, applies preferred quickfixes
2. **Whole-file sweep** — Scans the full file range for quickfixes (catches issues where diagnostics are stale, e.g. rust-analyzer unused imports not always emitting diagnostics)

### Debugging (DAP)

Full Debug Adapter Protocol support:

| Method | Description |
|--------|-------------|
| `debugStart` / `debugStop` | Start/stop debug sessions |
| `debugGetState` | Get current debug state |
| `debugSetBreakpoints` / `debugGetBreakpoints` / `debugRemoveAllBreakpoints` | Manage breakpoints |
| `debugContinue` / `debugPause` | Control execution flow |
| `debugStepOver` / `debugStepInto` / `debugStepOut` | Step through code |
| `debugGetThreads` | List debug threads |
| `debugGetStackTrace` | Get call stack frames |
| `debugGetScopes` / `debugGetVariables` | Inspect variable state |
| `debugEvaluate` | Evaluate expressions in paused context |
| `debugWaitForEvent` | Wait for debug events (stopped, terminated, etc.) |

---

## Configuration

```json
{
  "vscode-mcp-bridge.enableLog": true
}
```

## IDE Compatibility

The extension detects the host IDE at runtime: VS Code, Cursor, Windsurf, and Trae.

## Multi-Workspace Support

When multiple workspace folders are open, the extension creates socket aliases for each additional folder, enabling clients to connect to specific workspace contexts.

---

## Fork Notes

Personal fork of [tjx666/vscode-mcp](https://github.com/tjx666/vscode-mcp) with:

- **applyFixes handler** — Programmatic auto-fix with diagnostic-targeted and whole-file sweep strategies
- **DAP support** — Full Debug Adapter Protocol bridge for interactive debugging
- **CLI toolset** — `bridge-smart-debug`, `bridge-inspect`, `bridge-recon`, `bridge-diagnostics`
- **Claude Code integration** — Hook for auto-diagnostics, skills for `/lsp` and `/dap-debug`
- **Extended LSP** — 10+ new handlers (document symbols, inlay hints, completions, type hierarchy, etc.)
- **Smart symbol resolution** — Prefers definition sites over usage sites when disambiguating

## License

MIT
