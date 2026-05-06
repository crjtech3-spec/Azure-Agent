// Mocha test runner that the test-electron host loads.

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
    const testsRoot = path.resolve(__dirname);
    return new Promise((c, e) => {
        const files = fs.readdirSync(testsRoot).filter(f => f.endsWith('.test.js'));
        for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
        try {
            mocha.run(failures => failures > 0 ? e(new Error(`${failures} tests failed.`)) : c());
        } catch (err) { e(err); }
    });
}
