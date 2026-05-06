// Smoke tests for activation, command registration, and tool registry.

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'AzureAI.azure-ai-agent';

suite('Azure AI Agent — smoke', () => {
    test('extension is present and activates', async () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        assert.ok(ext, `Extension ${EXT_ID} not found`);
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true, 'Extension did not activate');
    });

    test('all advertised commands are registered', async () => {
        const expected = [
            'azure-ai-agent.startChat',
            'azure-ai-agent.runAgent',
            'azure-ai-agent.explainCode',
            'azure-ai-agent.fixCode',
            'azure-ai-agent.generateCode',
            'azure-ai-agent.clearChat',
            'azure-ai-agent.cancel',
            'azure-ai-agent.openSettings',
            'azure-ai-agent.setApiKey',
            'azure-ai-agent.clearApiKey',
            'azure-ai-agent.attachImage',
            'azure-ai-agent.showUsage'
        ];
        const all = await vscode.commands.getCommands(true);
        for (const c of expected) {
            assert.ok(all.includes(c), `Missing command: ${c}`);
        }
    });
});

suite('Azure AI Agent — tool registry', () => {
    test('registry exposes the expected tool set', () => {
        // Imported lazily so module-level state in extension.ts isn't required.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { buildToolRegistry } = require('../../tools');
        const reg = buildToolRegistry();
        const names = Object.keys(reg).sort();
        assert.deepStrictEqual(names, [
            'apply_patch',
            'delete_file',
            'edit_file',
            'get_diagnostics',
            'get_workspace_info',
            'glob_files',
            'list_directory',
            'read_file',
            'run_command',
            'search_text',
            'write_file'
        ]);
        for (const k of names) {
            const t = reg[k];
            assert.ok(t.spec.function.name === k, `name mismatch for ${k}`);
            assert.ok(typeof t.handler === 'function', `${k} handler missing`);
        }
        // Mutating tools must expose plan() for diff preview.
        for (const k of ['write_file', 'edit_file', 'apply_patch']) {
            assert.ok(typeof reg[k].plan === 'function', `${k} missing plan()`);
        }
    });
});
