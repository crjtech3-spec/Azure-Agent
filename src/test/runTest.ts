// vscode-test-electron entry point. Downloads a VS Code build and runs the
// mocha suite in `./suite`.

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        await runTests({ extensionDevelopmentPath, extensionTestsPath });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}
main();
