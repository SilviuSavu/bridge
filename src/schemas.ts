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
  __NOT_RECOMMEND__filePaths: z.array(FilePath).describe("Array of file paths to get diagnostics for. If empty, will get diagnostics for all git modified files."),
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

// ── getCodeActions (new) ──────────────────────────────────────────────

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

// ── getCallHierarchy (new) ────────────────────────────────────────────

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
