import { z } from "zod";

// ── Shared primitives ─────────────────────────────────────────────────

export const FilePath = z.string().describe("File path (absolute or relative to workspace root)");

const Position = z.object({ line: z.number(), character: z.number() });

export const Range = z.object({ start: Position, end: Position });

const LocationWithUsageCode = z.object({
  uri: z.string(),
  range: Range,
  usageCode: z.string().optional(),
});

export const SymbolParams = z.object({
  filePath: FilePath,
  symbol: z.string().describe("Symbol name"),
  codeSnippet: z.string().optional().describe(
    'Optional code snippet to help precisely locate the symbol when there are multiple symbols with the same name. Eg: "function getUserName()" when locating the symbol "getUserName"',
  ),
}).strict();

// ── health ────────────────────────────────────────────────────────────

export const healthPayload = z.object({}).strict();
export const healthResult = z.object({
  status: z.enum(["ok", "error"]),
  extension_version: z.string(),
  workspace: z.string().optional(),
  timestamp: z.string(),
  error: z.string().optional(),
  system_info: z.object({
    platform: z.string(),
    node_version: z.string(),
    vscode_version: z.string().optional(),
    ide_type: z.string().optional(),
  }).optional(),
}).strict();

// ── getDiagnostics ────────────────────────────────────────────────────

const DiagnosticItem = z.object({
  range: Range,
  message: z.string(),
  severity: z.enum(["error", "warning", "info", "hint"]),
  source: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
}).strict();

const DiagnosticFile = z.object({
  uri: z.string(),
  diagnostics: z.array(DiagnosticItem),
}).strict();

export const getDiagnosticsPayload = z.object({
  filePaths: z.array(FilePath).describe("Array of file paths to get diagnostics for. If empty, defaults to all git-modified files in the workspace."),
  sources: z.array(z.string()).optional().default([]).describe('Diagnostic sources to include (e.g., "eslint", "ts"). Empty = all.'),
  severities: z.array(z.enum(["error", "warning", "info", "hint"])).optional().default(["error", "warning", "info", "hint"]).describe("Severity levels to include."),
}).strict();

export const getDiagnosticsResult = z.object({
  files: z.array(DiagnosticFile),
}).strict();

// ── getReferences ─────────────────────────────────────────────────────

export const getReferencesPayload = SymbolParams.extend({
  includeDeclaration: z.boolean().optional().describe("Whether to include the declaration in the results"),
  usageCodeLineRange: z.number().optional().default(5).describe("Lines of context around each reference. 5 = ±5 lines, 0 = reference line only, -1 = no usage code"),
});

export const getReferencesResult = z.object({
  locations: z.array(LocationWithUsageCode),
}).strict();

// ── getSymbolLSPInfo ──────────────────────────────────────────────────

const InfoType = z.enum(["hover", "signature_help", "type_definition", "definition", "implementation", "all"]);
const HoverItem = z.object({ contents: z.union([z.string(), z.array(z.string())]), range: Range.optional() }).strict();
const ParameterInfo = z.object({ label: z.string(), documentation: z.string().optional() }).strict();
const SignatureInfo = z.object({ label: z.string(), documentation: z.string().optional(), parameters: z.array(ParameterInfo).optional() }).strict();
const SignatureHelp = z.object({ signatures: z.array(SignatureInfo), activeSignature: z.number().optional(), activeParameter: z.number().optional() }).strict();

export const getSymbolLSPInfoPayload = SymbolParams.extend({
  infoType: InfoType.optional().default("all").describe("Type of LSP information to retrieve."),
}).strict();

export const getSymbolLSPInfoResult = z.object({
  hover: z.array(HoverItem).optional(),
  signature_help: SignatureHelp.nullable().optional(),
  type_definition: z.array(LocationWithUsageCode).optional(),
  definition: z.array(LocationWithUsageCode).optional(),
  implementation: z.array(LocationWithUsageCode).optional(),
}).strict();

// ── executeCommand ────────────────────────────────────────────────────

export const executeCommandPayload = z.object({
  command: z.string().describe("VS Code command ID"),
  saveAllEditors: z.boolean().optional().default(true),
  args: z.string().optional().default("").describe("JSON string representing an array of arguments"),
}).strict();

export const executeCommandResult = z.object({
  result: z.unknown(),
}).strict();

// ── openFiles ─────────────────────────────────────────────────────────

const OpenFileSpec = z.object({
  filePath: FilePath,
  showEditor: z.boolean().optional().default(true),
}).strict();

const OpenFileResult = z.object({
  filePath: z.string(),
  success: z.boolean(),
  message: z.string().optional(),
}).strict();

export const openFilesPayload = z.object({ files: z.array(OpenFileSpec) }).strict();
export const openFilesResult = z.object({ results: z.array(OpenFileResult) }).strict();

// ── renameSymbol ──────────────────────────────────────────────────────

export const renameSymbolPayload = SymbolParams.extend({
  newName: z.string().describe("New symbol name"),
});

export const renameSymbolResult = z.object({
  success: z.boolean(),
  symbolName: z.string().optional(),
  modifiedFiles: z.array(z.object({ uri: z.string(), changeCount: z.number() })),
  totalChanges: z.number(),
  error: z.string().optional(),
}).strict();

// ── revertFiles ───────────────────────────────────────────────────────

const RevertFileResult = z.object({
  filePath: z.string(),
  success: z.boolean(),
  message: z.string().optional(),
}).strict();

export const revertFilesPayload = z.object({
  files: z.array(FilePath),
  waitForDiagnostics: z.boolean().optional().default(false).describe("Wait for diagnostics to settle after reverting."),
}).strict();

export const revertFilesResult = z.object({ results: z.array(RevertFileResult) }).strict();

// ── listWorkspaces ────────────────────────────────────────────────────

const WorkspaceInfo = z.object({
  workspace_path: z.string(),
  workspace_name: z.string().optional(),
  workspace_type: z.enum(["single-folder", "multi-folder", "workspace-file"]).optional(),
  folders: z.array(z.string()).optional(),
  status: z.enum(["active", "available", "error"]),
  extension_version: z.string().optional(),
  vscode_version: z.string().optional(),
  ide_type: z.string().optional(),
  socket_path: z.string().optional(),
  error: z.string().optional(),
  last_seen: z.string().optional(),
}).strict();

export const listWorkspacesResult = z.object({
  workspaces: z.array(WorkspaceInfo),
  summary: z.object({
    total: z.number(),
    active: z.number(),
    available: z.number(),
    cleaned: z.number(),
  }).strict(),
}).strict();

// ── getCodeActions ────────────────────────────────────────────────────

export const getCodeActionsPayload = z.object({
  filePath: FilePath,
  line: z.number().describe("0-indexed line number"),
  character: z.number().describe("0-indexed character/column"),
  endLine: z.number().optional().describe("0-indexed end line (defaults to line)"),
  endCharacter: z.number().optional().describe("0-indexed end character (defaults to character)"),
  kind: z.string().optional().describe("CodeAction kind filter (e.g. quickfix, refactor, source)"),
}).strict();

export const getCodeActionsResult = z.object({
  actions: z.array(z.object({
    title: z.string(),
    kind: z.string().optional(),
    isPreferred: z.boolean().optional(),
  })),
}).strict();

// ── applyFixes ───────────────────────────────────────────────────────

export const applyFixesPayload = z.object({
  filePath: FilePath,
  preferredOnly: z.boolean().optional().describe("Only apply preferred/suggested fixes (default: true)"),
}).strict();

export const applyFixesResult = z.object({
  applied: z.array(z.string()).describe("Titles of applied fixes"),
  skipped: z.number().describe("Number of diagnostics with no applicable fix"),
}).strict();

// ── getCallHierarchy ──────────────────────────────────────────────────

const CallHierarchyItemSchema = z.object({
  name: z.string(),
  kind: z.number(),
  uri: z.string(),
  detail: z.string().optional(),
  range: Range,
}).strict();

export const getCallHierarchyPayload = SymbolParams.extend({
  direction: z.enum(["incoming", "outgoing", "both"]).optional().default("both"),
}).strict();

export const getCallHierarchyResult = z.object({
  incoming: z.array(z.object({
    from: CallHierarchyItemSchema,
    fromRanges: z.array(Range),
  })).optional(),
  outgoing: z.array(z.object({
    to: CallHierarchyItemSchema,
    fromRanges: z.array(Range),
  })).optional(),
}).strict();

// ── getDocumentSymbols ────────────────────────────────────────────────

const DocumentSymbolItem: z.ZodType<{
  name: string;
  kind: number;
  range: z.infer<typeof Range>;
  selectionRange: z.infer<typeof Range>;
  detail?: string;
  children?: Array<{
    name: string;
    kind: number;
    range: z.infer<typeof Range>;
    selectionRange: z.infer<typeof Range>;
    detail?: string;
    children?: unknown[];
  }>;
}> = z.object({
  name: z.string(),
  kind: z.number(),
  range: Range,
  selectionRange: Range,
  detail: z.string().optional(),
  children: z.lazy(() => z.array(DocumentSymbolItem)).optional(),
}).strict();

export const getDocumentSymbolsPayload = z.object({
  filePath: FilePath,
}).strict();

export const getDocumentSymbolsResult = z.object({
  symbols: z.array(DocumentSymbolItem),
}).strict();

// ── getDocumentHighlights ─────────────────────────────────────────────

export const getDocumentHighlightsPayload = SymbolParams.strict();

export const getDocumentHighlightsResult = z.object({
  highlights: z.array(z.object({
    range: Range,
    kind: z.enum(["text", "read", "write"]),
  }).strict()),
}).strict();

// ── getFoldingRanges ──────────────────────────────────────────────────

export const getFoldingRangesPayload = z.object({
  filePath: FilePath,
}).strict();

export const getFoldingRangesResult = z.object({
  ranges: z.array(z.object({
    start: z.number().describe("0-indexed start line"),
    end: z.number().describe("0-indexed end line"),
    kind: z.enum(["comment", "imports", "region", "other"]).optional(),
  }).strict()),
}).strict();

// ── getSelectionRanges ────────────────────────────────────────────────

export const getSelectionRangesPayload = z.object({
  filePath: FilePath,
  positions: z.array(Position).describe("Positions to get selection ranges for"),
}).strict();

const SelectionRangeItem: z.ZodType<{
  range: z.infer<typeof Range>;
  parent?: { range: z.infer<typeof Range>; parent?: unknown };
}> = z.object({
  range: Range,
  parent: z.lazy(() => SelectionRangeItem).optional(),
}).strict();

export const getSelectionRangesResult = z.object({
  selectionRanges: z.array(SelectionRangeItem),
}).strict();

// ── getInlayHints ─────────────────────────────────────────────────────

export const getInlayHintsPayload = z.object({
  filePath: FilePath,
  range: Range.optional().describe("Range to get hints for. Defaults to full document."),
}).strict();

export const getInlayHintsResult = z.object({
  hints: z.array(z.object({
    position: Position,
    label: z.string(),
    kind: z.enum(["type", "parameter", "other"]).optional(),
    paddingLeft: z.boolean().optional(),
    paddingRight: z.boolean().optional(),
    tooltip: z.string().optional(),
  }).strict()),
}).strict();

// ── getWorkspaceSymbols ───────────────────────────────────────────────

export const getWorkspaceSymbolsPayload = z.object({
  query: z.string().describe("Symbol search query"),
}).strict();

export const getWorkspaceSymbolsResult = z.object({
  symbols: z.array(z.object({
    name: z.string(),
    kind: z.number(),
    containerName: z.string().optional(),
    location: z.object({
      uri: z.string(),
      range: Range,
    }).strict(),
  }).strict()),
}).strict();

// ── getDocumentLinks ──────────────────────────────────────────────────

export const getDocumentLinksPayload = z.object({
  filePath: FilePath,
}).strict();

export const getDocumentLinksResult = z.object({
  links: z.array(z.object({
    range: Range,
    target: z.string().optional(),
    tooltip: z.string().optional(),
  }).strict()),
}).strict();

// ── getCompletions ────────────────────────────────────────────────────

export const getCompletionsPayload = z.object({
  filePath: FilePath,
  line: z.number().describe("0-indexed line"),
  character: z.number().describe("0-indexed character"),
  triggerCharacter: z.string().optional().describe("Trigger character (e.g. '.', '(')"),
  maxResults: z.number().optional().default(50).describe("Maximum completions to return"),
}).strict();

export const getCompletionsResult = z.object({
  items: z.array(z.object({
    label: z.string(),
    kind: z.string().optional(),
    detail: z.string().optional(),
    documentation: z.string().optional(),
    insertText: z.string().optional(),
    sortText: z.string().optional(),
    filterText: z.string().optional(),
    preselect: z.boolean().optional(),
  }).strict()),
  isIncomplete: z.boolean().optional(),
}).strict();

// ── getColorInformation ──────────────────────────────────────────────

export const getColorInformationPayload = z.object({
  filePath: FilePath,
}).strict();

export const getColorInformationResult = z.object({
  colors: z.array(z.object({
    range: Range,
    color: z.object({
      red: z.number(),
      green: z.number(),
      blue: z.number(),
      alpha: z.number(),
    }).strict(),
  }).strict()),
}).strict();


// ── getTypeHierarchy ─────────────────────────────────────────────────

const TypeHierarchyItemSchema = z.object({
  name: z.string(),
  kind: z.number(),
  uri: z.string(),
  detail: z.string().optional(),
  range: Range,
}).strict();

export const getTypeHierarchyPayload = SymbolParams.extend({
  direction: z.enum(["supertypes", "subtypes", "both"]).optional().default("both"),
}).strict();

export const getTypeHierarchyResult = z.object({
  supertypes: z.array(TypeHierarchyItemSchema).optional(),
  subtypes: z.array(TypeHierarchyItemSchema).optional(),
}).strict();

// ══════════════════════════════════════════════════════════════════════
//                         DEBUG (DAP) SCHEMAS
// ══════════════════════════════════════════════════════════════════════

// ── debugGetState ─────────────────────────────────────────────────────

export const debugGetStatePayload = z.object({}).strict();
export const debugGetStateResult = z.object({
  status: z.enum(["running", "stopped", "noSession"]),
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  stoppedThreadId: z.number().optional(),
  stoppedReason: z.string().optional(),
  stoppedFile: z.string().optional(),
  stoppedLine: z.number().optional(),
}).strict();

// ── debugStart ────────────────────────────────────────────────────────

export const debugStartPayload = z.object({
  name: z.string().optional().describe("Debug session name"),
  type: z.string().optional().describe("Debug adapter type (e.g. node, lldb, python, cppdbg)"),
  request: z.enum(["launch", "attach"]).optional().default("launch"),
  program: z.string().optional().describe("Program to debug"),
  args: z.array(z.string()).optional().describe("Program arguments"),
  cwd: z.string().optional().describe("Working directory"),
  env: z.record(z.string()).optional().describe("Environment variables"),
  config: z.record(z.unknown()).optional().describe("Full launch config (overrides other fields)"),
  noDebug: z.boolean().optional().describe("Run without debugging"),
}).strict();

export const debugStartResult = z.object({
  success: z.boolean(),
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  error: z.string().optional(),
}).strict();

// ── debugStop ─────────────────────────────────────────────────────────

export const debugStopPayload = z.object({}).strict();
export const debugStopResult = z.object({
  success: z.boolean(),
  error: z.string().optional(),
}).strict();

// ── debugSetBreakpoints ───────────────────────────────────────────────

export const debugSetBreakpointsPayload = z.object({
  filePath: FilePath,
  breakpoints: z.array(z.object({
    line: z.number().describe("0-indexed line number"),
    condition: z.string().optional().describe("Conditional expression"),
    hitCondition: z.string().optional().describe("Hit count condition"),
    logMessage: z.string().optional().describe("Log message (logpoint)"),
  }).strict()),
}).strict();

export const debugSetBreakpointsResult = z.object({
  breakpoints: z.array(z.object({
    line: z.number(),
    verified: z.boolean(),
    condition: z.string().optional(),
  }).strict()),
}).strict();

// ── debugGetBreakpoints ───────────────────────────────────────────────

export const debugGetBreakpointsPayload = z.object({
  filePath: FilePath.optional(),
}).strict();

export const debugGetBreakpointsResult = z.object({
  breakpoints: z.array(z.object({
    filePath: z.string(),
    line: z.number(),
    enabled: z.boolean(),
    condition: z.string().optional(),
    hitCondition: z.string().optional(),
    logMessage: z.string().optional(),
  }).strict()),
}).strict();

// ── debugRemoveAllBreakpoints ─────────────────────────────────────────

export const debugRemoveAllBreakpointsPayload = z.object({
  filePath: FilePath.optional(),
}).strict();

export const debugRemoveAllBreakpointsResult = z.object({
  removed: z.number(),
}).strict();

// ── debugContinue / stepOver / stepInto / stepOut / pause ──────────────

export const debugThreadActionPayload = z.object({
  threadId: z.number().optional().describe("Thread ID (defaults to first thread)"),
}).strict();

export const debugThreadActionResult = z.object({
  success: z.boolean(),
  error: z.string().optional(),
}).strict();

// ── debugGetThreads ───────────────────────────────────────────────────

export const debugGetThreadsPayload = z.object({}).strict();
export const debugGetThreadsResult = z.object({
  threads: z.array(z.object({
    id: z.number(),
    name: z.string(),
  }).strict()),
}).strict();

// ── debugGetStackTrace ────────────────────────────────────────────────

export const debugGetStackTracePayload = z.object({
  threadId: z.number(),
  startFrame: z.number().optional().default(0),
  levels: z.number().optional().default(20),
}).strict();

export const debugGetStackTraceResult = z.object({
  stackFrames: z.array(z.object({
    id: z.number(),
    name: z.string(),
    source: z.string().optional(),
    line: z.number(),
    column: z.number(),
  }).strict()),
  totalFrames: z.number(),
}).strict();

// ── debugGetScopes ────────────────────────────────────────────────────

export const debugGetScopesPayload = z.object({
  frameId: z.number(),
}).strict();

export const debugGetScopesResult = z.object({
  scopes: z.array(z.object({
    name: z.string(),
    variablesReference: z.number(),
    expensive: z.boolean(),
    namedVariables: z.number().optional(),
    indexedVariables: z.number().optional(),
  }).strict()),
}).strict();

// ── debugGetVariables ─────────────────────────────────────────────────

export const debugGetVariablesPayload = z.object({
  variablesReference: z.number(),
  filter: z.enum(["indexed", "named"]).optional(),
  start: z.number().optional(),
  count: z.number().optional(),
}).strict();

export const debugGetVariablesResult = z.object({
  variables: z.array(z.object({
    name: z.string(),
    value: z.string(),
    type: z.string().optional(),
    variablesReference: z.number(),
    namedVariables: z.number().optional(),
    indexedVariables: z.number().optional(),
  }).strict()),
}).strict();

// ── debugEvaluate ─────────────────────────────────────────────────────

export const debugEvaluatePayload = z.object({
  expression: z.string(),
  frameId: z.number().optional(),
  context: z.enum(["watch", "repl", "hover"]).optional().default("repl"),
}).strict();

export const debugEvaluateResult = z.object({
  result: z.string(),
  type: z.string().optional(),
  variablesReference: z.number(),
  namedVariables: z.number().optional(),
  indexedVariables: z.number().optional(),
}).strict();

// ── debugWaitForEvent ─────────────────────────────────────────────────

export const debugWaitForEventPayload = z.object({
  timeoutMs: z.number().optional().default(30000).describe("Timeout in milliseconds"),
}).strict();

export const debugWaitForEventResult = z.object({
  event: z.enum(["stopped", "terminated", "timeout", "noSession", "disposed"]),
  threadId: z.number().optional(),
  reason: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
}).strict();
