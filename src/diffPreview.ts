// Diff-based approval. Writes the proposed new content to a temp file,
// opens it side-by-side against the original via VS Code's built-in diff
// editor, and asks the user to Approve / Deny. Cleans up after.

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

export interface DiffPreviewRequest {
    title: string;
    relPath: string;
    originalContent: string;        // empty for new files
    proposedContent: string;
    languageId?: string;
}

export type DiffDecision = 'approve' | 'deny' | 'edit';

export async function previewDiffAndAsk(req: DiffPreviewRequest): Promise<DiffDecision> {
    const id = crypto.randomBytes(6).toString('hex');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `azure-ai-agent-${id}-`));
    const safeName = req.relPath.replace(/[\\/:*?"<>|]/g, '_');

    const leftPath = path.join(dir, `original_${safeName}`);
    const rightPath = path.join(dir, `proposed_${safeName}`);

    try {
        await fs.writeFile(leftPath, req.originalContent, 'utf8');
        await fs.writeFile(rightPath, req.proposedContent, 'utf8');
        const left = vscode.Uri.file(leftPath);
        const right = vscode.Uri.file(rightPath);
        await vscode.commands.executeCommand('vscode.diff', left, right, req.title, {
            preview: true,
            preserveFocus: false
        });
        const quickApprove = vscode.commands.registerCommand('azure-ai-agent.diffApprove', () => 'Approve');
        const quickDeny = vscode.commands.registerCommand('azure-ai-agent.diffDeny', () => 'Deny');
        const quickEdit = vscode.commands.registerCommand('azure-ai-agent.diffEdit', () => 'Edit in editor');
        try {
            const pick = await vscode.window.showInformationMessage(
                req.title,
                { modal: true, detail: 'Review the diff in the editor, then choose: Approve, Deny, or Edit. Keyboard shortcuts can be bound to azure-ai-agent.diffApprove / diffDeny / diffEdit.' },
                'Approve',
                'Edit in editor',
                'Deny'
            );
            if (pick === 'Approve') return 'approve';
            if (pick === 'Edit in editor') return 'edit';
            return 'deny';
        } finally {
            quickApprove.dispose();
            quickDeny.dispose();
            quickEdit.dispose();
        }
    } finally {
        // Best-effort: close the diff editor and remove temp files.
        try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch { /* ignore */ }
        try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
