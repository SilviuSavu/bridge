import * as vscode from "vscode";

/**
 * Resolve a symbol name to a vscode.Position within a document.
 * If codeSnippet is provided, narrows the search to that snippet first.
 */
export async function resolveSymbolPosition(
  uri: vscode.Uri,
  symbol: string,
  codeSnippet?: string,
): Promise<vscode.Position> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  return codeSnippet
    ? resolveWithSnippet(text, symbol, codeSnippet, doc)
    : resolveWithoutSnippet(text, symbol, doc);
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function resolveWithoutSnippet(text: string, symbol: string, doc: vscode.TextDocument): vscode.Position {
  const positions: vscode.Position[] = [];
  const re = new RegExp(String.raw`\b${escapeRegex(symbol)}\b`, "g");
  let match = re.exec(text);
  while (match !== null) {
    positions.push(doc.positionAt(match.index));
    match = re.exec(text);
  }
  if (positions.length === 0) throw new Error(`Symbol "${symbol}" not found in file`);
  if (positions.length > 1) throw new Error(`Multiple occurrences of "${symbol}" found. Please provide codeSnippet to disambiguate.`);
  return positions[0];
}

function resolveWithSnippet(text: string, symbol: string, codeSnippet: string, doc: vscode.TextDocument): vscode.Position {
  // Find snippet occurrences
  const snippetOccurrences: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(codeSnippet, searchFrom);
    if (idx === -1) break;
    snippetOccurrences.push({ start: idx, end: idx + codeSnippet.length });
    searchFrom = idx + 1;
  }
  if (snippetOccurrences.length === 0) throw new Error(`Code snippet "${codeSnippet}" not found in file`);
  if (snippetOccurrences.length > 1) throw new Error(`Code snippet "${codeSnippet}" appears ${snippetOccurrences.length} times in file. Please be more specific.`);

  // Find symbol within snippet
  const occ = snippetOccurrences[0];
  const snippetText = text.slice(occ.start, occ.end);
  const re = new RegExp(String.raw`\b${escapeRegex(symbol)}\b`, "g");
  const positions: vscode.Position[] = [];
  let match = re.exec(snippetText);
  while (match !== null) {
    positions.push(doc.positionAt(occ.start + match.index));
    match = re.exec(snippetText);
  }
  if (positions.length === 0) throw new Error(`Symbol "${symbol}" not found in code snippet "${codeSnippet}"`);
  if (positions.length > 1) throw new Error(`Multiple occurrences of "${symbol}" found in code snippet. Please use a more specific snippet.`);
  return positions[0];
}
