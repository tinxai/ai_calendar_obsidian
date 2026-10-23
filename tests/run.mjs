// Bundles the unit tests with an `obsidian` stub and runs them with node:test.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '.out', 'unit.test.cjs');
await esbuild.build({
	entryPoints: [path.join(here, 'unit.test.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile,
	alias: { obsidian: path.join(here, 'obsidian-stub.ts') },
	logLevel: 'error',
});
const r = spawnSync(process.execPath, ['--test', outfile], {
	stdio: 'inherit',
});
process.exit(r.status ?? 1);
