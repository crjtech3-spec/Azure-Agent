// Loads workspace-level agent instructions (AGENTS.md / CLAUDE.md /
// .azure-ai-agent/instructions.md) and prepends them to the system prompt.

import * as vscode from 'vscode';
import * as path from 'path';

export async function loadWorkspaceInstructions(candidates: string[]): Promise<{ source: string; content: string } | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    const root = folders[0].uri;
    for (const rel of candidates) {
        const uri = vscode.Uri.joinPath(root, rel);
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(data).toString('utf8').trim();
            if (text.length > 0) {
                return { source: path.posix.normalize(rel), content: text };
            }
        } catch { /* not present, try next */ }
    }
    return undefined;
}

export function composeSystemPrompt(base: string, instructions?: { source: string; content: string }): string {
    if (!instructions) return base;
    return `${base}\n\n# Workspace instructions (from ${instructions.source})\n\n${instructions.content}`;
}
