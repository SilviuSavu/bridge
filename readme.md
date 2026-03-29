# VSCode MCP Bridge

<div align="center">

[![Version](https://img.shields.io/visual-studio-marketplace/v/YuTengjing.vscode-mcp-bridge)](https://marketplace.visualstudio.com/items/YuTengjing.vscode-mcp-bridge/changelog) [![Installs](https://img.shields.io/visual-studio-marketplace/i/YuTengjing.vscode-mcp-bridge)](https://marketplace.visualstudio.com/items?itemName=YuTengjing.vscode-mcp-bridge) [![Downloads](https://img.shields.io/visual-studio-marketplace/d/YuTengjing.vscode-mcp-bridge)](https://marketplace.visualstudio.com/items?itemName=YuTengjing.vscode-mcp-bridge) [![Rating Star](https://img.shields.io/visual-studio-market-place/stars/YuTengjing.vscode-mcp-bridge)](https://marketplace.visualstudio.com/items?itemName=YuTengjing.vscode-mcp-bridge&ssr=false#review-details) [![Last Updated](https://img.shields.io/visual-studio-marketplace/last-updated/YuTengjing.vscode-mcp-bridge)](https://github.com/tjx666/vscode-mcp)

</div>

Bridge between VS Code language servers and MCP clients over Unix socket. Enables AI/code assistants to leverage VS Code's built-in language features.

## Architecture

The extension starts a Unix socket server that exposes VS Code's Language Server Protocol (LSP) and Debug Adapter Protocol (DAP) capabilities to external MCP clients via JSON-RPC over a Unix domain socket.

```
┌─────────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  MCP Client    │ ←→   │  Socket Server  │ ←→   │  VS Code LSP/DAP │
│  (AI Assistant)│      │  (Unix Socket)  │      │  Language Servers │
└─────────────────┘      └──────────────────┘      └────────────────────┘
```

## Installation & Usage

Check [VSCode MCP Repository](https://github.com/tjx666/vscode-mcp) for setup instructions and usage examples.

---

## Supported Operations

### Language Features (LSP)

| Method | Description |
|--------|-------------|
| `health` | Extension health check with system info, IDE type detection |
| `getDiagnostics` | Fetch diagnostics with optional filtering by source and severity |
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

### Code Actions & Hierarchy

- **`getCodeActions`** — Get quick-fixes and refactorings at a cursor position
- **`getCallHierarchy`** — Get incoming/outgoing calls for a function/method

### Debugging (DAP)

Full Debug Adapter Protocol support:

- **`debugStart`** / **`debugStop`** — Start/stop debug sessions
- **`debugGetState`** — Get current debug state
- **`debugSetBreakpoints`** / **`debugGetBreakpoints`** / **`debugRemoveAllBreakpoints`** — Manage breakpoints
- **`debugContinue`** / **`debugPause`** — Control execution flow
- **`debugStepOver`** / **`debugStepInto`** / **`debugStepOut`** — Step through code
- **`debugGetThreads`** — List debug threads
- **`debugGetStackTrace`** — Get call stack frames
- **`debugGetScopes`** / **`debugGetVariables`** — Inspect variable state
- **`debugEvaluate`** — Evaluate expressions in paused context

---

## VS Code Commands & Keybindings

### Copy Opened Files Path

**Command**: `VSCode MCP Bridge: Copy Opened Files Path`

Keyboard shortcut: `` alt+cmd+o ``

Sends all opened file paths to the active terminal.

### Sleep

**Command**: `VSCode MCP Bridge: Sleep`

Utility command that pauses execution for a specified duration (in seconds). Designed for use in VS Code shortcuts.json `runCommands` sequences to add delays between multiple commands.

### Copy Current Selection Reference

**Command**: `VSCode MCP Bridge: Copy Current Selection Reference`

 Copies the current selection as a reference string.

---

## Configuration

```json
{
  "vscode-mcp-bridge.enableLog": true // Enable/disable logging (default: true)
}
```

---

## IDE Compatibility

The extension detects the host IDE at runtime:

- **Visual Studio Code**
- **Cursor** (via command detection)
- **Windsurf** (via command detection)
- **Trae** (via command detection)

---

## Multi-Workspace Support

When multiple workspace folders are open, the extension creates socket aliases for each additional folder, enabling clients to connect to specific workspace contexts.

---

## Fork Notes

This is a personal fork of the original [tjx666/vscode-mcp](https://github.com/tjx666/vscode-mcp) repository with additional features and bug fixes.

### Recent Changes

- **DAP Support**: Added full Debug Adapter Protocol bridge support for interactive debugging
- **Extended LSP**: Added 10+ new LSP handlers (document symbols, folding ranges, inlay hints, completions, color info, type hierarchy)
- **Workspace-Aware Resolution**: Improved path resolution for multi-folder workspaces
- **IDE Detection**: Runtime detection of VS Code, Cursor, Windsurf, and Trae editors

---

## License

MIT — Originally published on Visual Studio Marketplace by YuTengjing.