type ChildProcess = import('node:child_process').ChildProcess;
type Spawn = typeof import('node:child_process').spawn;
type FsSync = typeof import('node:fs');
type Fs = typeof import('node:fs/promises');
type Os = typeof import('node:os');
type Path = typeof import('node:path');

import { Platform } from 'obsidian';
import { type PlannerReply, parsePlannerReply } from './planner-model';

export interface PlanningRequest {
	result: Promise<PlannerReply>;
	cancel: () => void;
}

const schema = {
	type: 'object',
	additionalProperties: false,
	required: ['message', 'edits'],
	properties: {
		message: { type: 'string' },
		edits: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['path', 'content'],
				properties: { path: { type: 'string' }, content: { type: 'string' } },
			},
		},
	},
};

/** Use the installed CLI's login; credentials never enter plugin data or prompts. */
export function askPlanningCodex(prompt: string): PlanningRequest {
	let child: ChildProcess | null = null;
	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		child?.kill();
	};
	const result = (async (): Promise<PlannerReply> => {
		const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
		if (!Platform.isDesktop || !nodeRequire)
			throw new Error(
				'Planning AI uses your local Codex login and is available on desktop. You can edit the plan notes on mobile.',
			);
		const fs = nodeRequire('node:fs/promises') as Fs;
		const fsSync = nodeRequire('node:fs') as FsSync;
		const os = nodeRequire('node:os') as Os;
		const path = nodeRequire('node:path') as Path;
		const { spawn } = nodeRequire('node:child_process') as { spawn: Spawn };
		const home = os.homedir();
		const nodeProcess = nodeRequire('node:process') as {
			env: Record<string, string | undefined>;
		};
		const candidates = [
			path.join(home, '.local/bin/codex'),
			'/opt/homebrew/bin/codex',
			'/usr/local/bin/codex',
			'/Applications/Codex.app/Contents/Resources/codex',
		];
		const executable = candidates.find((candidate) => fsSync.existsSync(candidate));
		if (!executable)
			throw new Error(
				'Codex CLI was not found. Install the CLI and run codex login, then try again.',
			);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-planning-'));
		try {
			const schemaPath = path.join(directory, 'reply-schema.json');
			const outputPath = path.join(directory, 'reply.json');
			await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');
			if (cancelled) throw new Error('Request cancelled.');
			await new Promise<void>((resolve, reject) => {
				child = spawn(
					executable,
					[
						'exec',
						'--ignore-user-config',
						'--ephemeral',
						'--skip-git-repo-check',
						'--sandbox',
						'read-only',
						'--disable',
						'shell_tool',
						'--disable',
						'unified_exec',
						'--disable',
						'multi_agent',
						'--disable',
						'plugins',
						'-c',
						'web_search="disabled"',
						'-c',
						'project_doc_max_bytes=0',
						'--output-schema',
						schemaPath,
						'--output-last-message',
						outputPath,
						'--color',
						'never',
						'-',
					],
					{
						cwd: directory,
						shell: false,
						stdio: ['pipe', 'ignore', 'pipe'],
						// GUI applications often have a minimal PATH. Include the CLI's own directory.
						env: {
							...nodeProcess.env,
							PATH: `${path.dirname(executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${nodeProcess.env.PATH ?? ''}`,
						},
					},
				);
				let timedOut = false;
				const timer = window.setTimeout(() => {
					timedOut = true;
					child?.kill();
				}, 180000);
				child.stderr?.on('data', () => {});
				child.stdin?.on('error', () => {});
				child.once('error', () => {
					window.clearTimeout(timer);
					reject(
						new Error(
							'Could not start Codex. Check that the CLI is installed and logged in.',
						),
					);
				});
				child.once('close', (code) => {
					window.clearTimeout(timer);
					if (timedOut)
						reject(new Error('Codex took too long to respond. Please try again.'));
					else if (cancelled) reject(new Error('Request cancelled.'));
					else if (code !== 0)
						reject(
							new Error(
								'Codex could not complete the request. Check your connection and run codex login status in Terminal.',
							),
						);
					else resolve();
				});
				child.stdin?.end(prompt);
			});
			if (cancelled) throw new Error('Request cancelled.');
			const stat = await fs.stat(outputPath);
			if (stat.size > 800000)
				throw new Error(
					'The assistant returned too much data. Please ask for a smaller change.',
				);
			return parsePlannerReply(await fs.readFile(outputPath, 'utf8'));
		} finally {
			child = null;
			await fs.rm(directory, { recursive: true, force: true });
		}
	})();
	return { result, cancel };
}
