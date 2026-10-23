import { type App, normalizePath, TFile, TFolder } from 'obsidian';
import type { Cache, TaskFields, TaskIndex, TaskState } from './cache';
import { type GoogleClient, GoogleError } from './google';

const API = 'https://tasks.googleapis.com/tasks/v1';
export const TASK_STATUSES = ['backlog', 'active', 'blocked', 'done'] as const;

/** Every task the plugin creates from a note starts its `notes` with a link back to that note. */
const BACKLINK = 'obsidian://open?';

/**
 * How long one side of a pair may be missing before the other side follows. Vault sync is slower than Google: a note
 * deleted or renamed on one device is still the old file on another for a while, and acting on that stale copy would
 * delete a live task or bring a deleted note back.
 */
export const ABSENCE_GRACE_MS = 10 * 60_000;

/** True when a Google task came from a note on some device, as opposed to being typed into a Google app. */
export function linksToNote(notes: string | undefined): boolean {
	return (notes ?? '').startsWith(BACKLINK);
}

/** Vault path of the note a task links back to, or '' when it has no back-link. */
export function backlinkPath(notes: string | undefined): string {
	if (!linksToNote(notes)) return '';
	try {
		const file = new URL((notes ?? '').split('\n')[0] ?? '').searchParams.get('file');
		return file ? `${file}.md` : '';
	} catch {
		return '';
	}
}

/** Of several notes that claim one task, the one every device keeps: the note the task links back to, else the first path. */
export function canonicalPath(paths: string[], linked: string): string {
	return paths.includes(linked) ? linked : ([...paths].sort()[0] ?? '');
}

/**
 * Three-way merge of the mirrored fields. A field that only one side changed since `base` takes that side; a field both
 * sides changed goes to the newer side. Without a base (first pairing) the newer side wins every differing field.
 */
export function mergeFields(
	local: TaskFields,
	remote: TaskFields,
	base: TaskFields | undefined,
	remoteNewer: boolean,
): { pull: Partial<TaskFields>; push: Partial<TaskFields> } {
	const pull: Partial<TaskFields> = {};
	const push: Partial<TaskFields> = {};
	for (const k of ['title', 'due', 'done'] as const) {
		if (local[k] === remote[k]) continue;
		const localChanged = base ? local[k] !== base[k] : !remoteNewer;
		const remoteChanged = base ? remote[k] !== base[k] : remoteNewer;
		if (localChanged && remoteChanged ? remoteNewer : remoteChanged)
			setField(pull, k, remote[k]);
		else setField(push, k, local[k]);
	}
	return { pull, push };
}

function setField<K extends keyof TaskFields>(
	o: Partial<TaskFields>,
	k: K,
	v: TaskFields[K],
): void {
	o[k] = v;
}

export interface TaskNote {
	file: TFile;
	project: string;
	title: string;
	due: string;
	status: string;
	googleId: string;
}

interface GoogleTask {
	id: string;
	title?: string;
	notes?: string;
	status?: 'needsAction' | 'completed';
	due?: string;
	completed?: string | null;
	updated?: string;
	deleted?: boolean;
}

interface Remote {
	task: GoogleTask;
	listId: string;
	project: string;
}

export interface MirrorResult {
	pushed: number;
	pulled: number;
	imported: number;
	deleted: number;
	total: number;
	/** Paths of notes skipped because another note claims the same task. */
	duplicates: string[];
}

export interface MirrorHost {
	app: App;
	google: GoogleClient;
	cache: Cache;
	settings: { projectsFolder: string; taskLists: Record<string, string> };
	/** Persists settings after taskLists changed. */
	saveSettings(): Promise<void>;
}

function fmString(v: unknown): string {
	if (typeof v === 'string') return v.trim();
	if (typeof v === 'number') return String(v);
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return '';
}

type Frontmatter = Record<string, unknown>;

/** Task notes under <projectsFolder>/<project>/tasks/*.md whose frontmatter has type: Task. */
export function collectTaskNotes(app: App, projectsFolder: string): TaskNote[] {
	const root = app.vault.getFolderByPath(normalizePath(projectsFolder));
	const out: TaskNote[] = [];
	if (!root) return out;
	for (const project of root.children) {
		if (!(project instanceof TFolder)) continue;
		const tasks = app.vault.getFolderByPath(`${project.path}/tasks`);
		if (!tasks) continue;
		for (const f of tasks.children) {
			if (!(f instanceof TFile) || f.extension !== 'md') continue;
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm || fm.type !== 'Task') continue;
			out.push({
				file: f,
				project: project.name,
				title: fmString(fm.title) || f.basename,
				due: fmString(fm.due).slice(0, 10),
				status: fmString(fm.status) || 'backlog',
				googleId: fmString(fm.google_task_id),
			});
		}
	}
	return out;
}

export function safeFileName(title: string): string {
	const s = title
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return s || 'Untitled task';
}

function toDue(due: string): string | undefined {
	return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : undefined;
}

function fieldsOf(note: TaskNote): TaskFields {
	return { title: note.title, due: note.due, done: note.status === 'done' };
}

function remoteFields(t: GoogleTask): TaskFields {
	return {
		title: t.title ?? '',
		due: (t.due ?? '').slice(0, 10),
		done: t.status === 'completed',
	};
}

export class TaskMirror {
	private lists: Array<{ id: string; title: string }> | null = null;

	constructor(private host: MirrorHost) {}

	private get app() {
		return this.host.app;
	}

	async sync(): Promise<MirrorResult> {
		const result: MirrorResult = {
			pushed: 0,
			pulled: 0,
			imported: 0,
			deleted: 0,
			total: 0,
			duplicates: [],
		};
		const root = this.app.vault.getFolderByPath(
			normalizePath(this.host.settings.projectsFolder),
		);
		if (!root) return result;
		const projects = root.children
			.filter((c): c is TFolder => c instanceof TFolder)
			.map((f) => f.name);
		if (projects.length === 0) return result;
		this.lists = null;
		let listsChanged = false;

		// 1. Remote tasks of every current project list.
		const remote = new Map<string, Remote>();
		const listOf: Record<string, string> = {};
		for (const project of projects) {
			let listId: string = this.host.settings.taskLists[project] ?? '';
			let tasks: GoogleTask[] | null = listId ? await this.listTasks(listId) : null;
			if (!tasks) {
				listId = await this.ensureList(project);
				listsChanged = true;
				tasks = (await this.listTasks(listId)) ?? [];
			}
			listOf[project] = listId;
			for (const t of tasks) if (!t.deleted) remote.set(t.id, { task: t, listId, project });
		}

		// 2. Local notes.
		const notes = collectTaskNotes(this.app, this.host.settings.projectsFolder);
		const index = this.host.cache.taskIndex();
		const state = this.host.cache.taskState();
		const idByPath = new Map(Object.entries(index).map(([id, path]) => [path, id]));
		const nextIndex: TaskIndex = {};
		const next: TaskState = { base: {}, absent: {} };
		const matched = new Set<string>();
		const now = Date.now();
		/** How long `key` has been missing, starting its clock the first time it is asked. */
		const missingFor = (key: string): number => {
			const since = state.absent[key] ?? now;
			next.absent[key] = since;
			return now - since;
		};

		// Which task each note claims. The metadata cache can lag behind an id this plugin just wrote; the previous index knows it.
		const claimOf = new Map<TaskNote, string>();
		const claimants = new Map<string, TaskNote[]>();
		for (const note of notes) {
			const id = remote.has(note.googleId)
				? note.googleId
				: (idByPath.get(note.file.path) ?? note.googleId);
			claimOf.set(note, id);
			if (remote.has(id)) claimants.set(id, [...(claimants.get(id) ?? []), note]);
		}
		// Several notes claiming one task are sync conflict copies or copied notes. Mirroring each would create a task per
		// copy, which other devices then import as notes. Keep the one every device agrees on and leave the rest to the user.
		const skipped = new Set<TaskNote>();
		for (const [id, group] of claimants) {
			if (group.length < 2) continue;
			const keep = canonicalPath(
				group.map((n) => n.file.path),
				backlinkPath(remote.get(id)?.task.notes),
			);
			for (const n of group) if (n.file.path !== keep) skipped.add(n);
		}
		result.duplicates = [...skipped].map((n) => n.file.path).sort();
		// Tasks by the note they link back to, for a note that has not received its task's id yet.
		const byBacklink = new Map<string, Remote>();
		for (const r of remote.values()) {
			const path = backlinkPath(r.task.notes);
			if (path && !claimants.has(r.task.id) && !byBacklink.has(path)) byBacklink.set(path, r);
		}

		for (const note of notes) {
			const listId = listOf[note.project];
			if (!listId || skipped.has(note)) continue;
			const id = claimOf.get(note) ?? '';
			let r = remote.get(id);
			if (!r && !id) {
				// Another device made this note's task and its id is still on the way here: pair through the back-link.
				const linked = byBacklink.get(note.file.path);
				if (linked && !matched.has(linked.task.id)) r = linked;
			}
			if (!r) {
				// The note had a task that Google no longer has. It was deleted in a Google app, or by a device on which this
				// note is already deleted; in the second case the deletion is still travelling here. Wait before re-creating.
				if (id && missingFor(`task:${id}`) < ABSENCE_GRACE_MS) {
					nextIndex[id] = note.file.path;
					continue;
				}
				const created = await this.insert(listId, note);
				await this.app.fileManager.processFrontMatter(note.file, (fm: Frontmatter) => {
					fm.google_task_id = created.id;
				});
				nextIndex[created.id] = note.file.path;
				next.base[created.id] = fieldsOf(note);
				result.pushed++;
				continue;
			}
			matched.add(r.task.id);
			if (r.listId !== listId) {
				r.task = await this.host.google.call<GoogleTask>(
					'POST',
					`${API}/lists/${enc(r.listId)}/tasks/${enc(r.task.id)}/move`,
					{
						query: { destinationTasklist: listId },
					},
				);
				r.listId = listId;
				result.pushed++;
			}
			const { pushed, pulled, agreed } = await this.reconcile(note, r, state.base[r.task.id]);
			if (pushed) result.pushed++;
			if (pulled) result.pulled++;
			nextIndex[r.task.id] = note.file.path;
			next.base[r.task.id] = agreed;
		}

		// 3. Remote tasks without a note.
		for (const [id, r] of remote) {
			if (matched.has(id) || claimants.has(id)) continue;
			const knownPath = index[id];
			if (knownPath) {
				if (this.app.vault.getFileByPath(knownPath)) {
					// The note still exists but was not scanned (metadata not ready or moved out of the projects folder). Leave both sides alone.
					nextIndex[id] = knownPath;
					continue;
				}
				// The note this device last paired with the task is gone. Delete the task only once the note has stayed gone,
				// so a rename or move that vault sync is still delivering does not cost the task.
				if (missingFor(`note:${id}`) < ABSENCE_GRACE_MS) {
					nextIndex[id] = knownPath;
					continue;
				}
				try {
					await this.host.google.call(
						'DELETE',
						`${API}/lists/${enc(r.listId)}/tasks/${enc(id)}`,
					);
				} catch (e) {
					// Another device that also saw the note go deleted it first.
					if (!(e instanceof GoogleError && e.status === 404)) throw e;
				}
				result.deleted++;
				continue;
			}
			// A task that links back to a note was made from a note on some device. Its note has not reached this device yet,
			// or was deleted on a device that deletes the task itself. Only tasks typed into a Google app are new.
			if (linksToNote(r.task.notes)) continue;
			const path = await this.importNote(r);
			nextIndex[id] = path;
			next.base[id] = remoteFields(r.task);
			result.imported++;
		}

		this.host.cache.saveTaskIndex(nextIndex);
		this.host.cache.saveTaskState(next);
		if (listsChanged) await this.host.saveSettings();
		result.total = Object.keys(nextIndex).length;
		return result;
	}

	private async listTasks(listId: string): Promise<GoogleTask[] | null> {
		const out: GoogleTask[] = [];
		let pageToken: string | undefined;
		try {
			do {
				const page = await this.host.google.call<{
					items?: GoogleTask[];
					nextPageToken?: string;
				}>('GET', `${API}/lists/${enc(listId)}/tasks`, {
					query: {
						showCompleted: true,
						showHidden: true,
						maxResults: 100,
						pageToken,
					},
				});
				out.push(...(page.items ?? []));
				pageToken = page.nextPageToken;
			} while (pageToken);
		} catch (e) {
			if (e instanceof GoogleError && e.status === 404) return null; // list was deleted at Google
			throw e;
		}
		return out;
	}

	private async ensureList(project: string): Promise<string> {
		if (!this.lists) {
			const page = await this.host.google.call<{
				items?: Array<{ id: string; title: string }>;
			}>('GET', `${API}/users/@me/lists`, { query: { maxResults: 100 } });
			this.lists = page.items ?? [];
		}
		let list = this.lists.find((l) => l.title === project);
		if (!list) {
			list = await this.host.google.call<{ id: string; title: string }>(
				'POST',
				`${API}/users/@me/lists`,
				{ body: { title: project } },
			);
			this.lists.push(list);
		}
		this.host.settings.taskLists[project] = list.id;
		return list.id;
	}

	private body(note: TaskNote): Record<string, unknown> {
		const body: Record<string, unknown> = {
			title: note.title,
			status: note.status === 'done' ? 'completed' : 'needsAction',
			notes: this.backlink(note.file),
		};
		const due = toDue(note.due);
		if (due) body.due = due;
		return body;
	}

	private backlink(file: TFile): string {
		const vault = encodeURIComponent(this.app.vault.getName());
		return `obsidian://open?vault=${vault}&file=${encodeURIComponent(file.path.replace(/\.md$/, ''))}`;
	}

	private insert(listId: string, note: TaskNote): Promise<GoogleTask> {
		return this.host.google.call<GoogleTask>('POST', `${API}/lists/${enc(listId)}/tasks`, {
			body: this.body(note),
		});
	}

	/**
	 * Brings one pair together field by field ({@link mergeFields}): what changed in Google since the last sync comes to the
	 * note, what changed in the note goes to Google. Also restores the back-link on a task that lost it, so that no other
	 * device mistakes the task for one typed on a phone.
	 */
	private async reconcile(
		note: TaskNote,
		r: Remote,
		base: TaskFields | undefined,
	): Promise<{ pushed: boolean; pulled: boolean; agreed: TaskFields }> {
		const t = r.task;
		const local = fieldsOf(note);
		const remoteNewer = Date.parse(t.updated ?? '') > note.file.stat.mtime;
		const { pull, push } = mergeFields(local, remoteFields(t), base, remoteNewer);
		const agreed = { ...local, ...pull };
		const pulled = Object.keys(pull).length > 0;
		if (pulled) {
			await this.app.fileManager.processFrontMatter(note.file, (fm: Frontmatter) => {
				if (pull.title !== undefined) fm.title = pull.title;
				if (pull.due !== undefined) {
					if (pull.due) fm.due = pull.due;
					else delete fm.due;
				}
				if (pull.done === true) fm.status = 'done';
				else if (pull.done === false && local.done) fm.status = 'backlog';
			});
			if (pull.title) {
				const target = await this.freePath(
					note.file.parent?.path ?? '',
					pull.title,
					note.file,
				);
				if (target !== note.file.path)
					await this.app.fileManager.renameFile(note.file, target);
			}
		}
		const patch: Record<string, unknown> = {};
		if (push.title !== undefined) patch.title = push.title;
		if (push.due !== undefined) patch.due = toDue(push.due) ?? null;
		if (push.done !== undefined) {
			patch.status = push.done ? 'completed' : 'needsAction';
			if (!push.done) patch.completed = null;
		}
		if (!linksToNote(t.notes)) patch.notes = this.notesWithBacklink(note.file, t.notes);
		if (Object.keys(patch).length) {
			r.task = await this.host.google.call<GoogleTask>(
				'PATCH',
				`${API}/lists/${enc(r.listId)}/tasks/${enc(t.id)}`,
				{ body: patch },
			);
		}
		return { pushed: Object.keys(push).length > 0, pulled, agreed };
	}

	/** The back-link first, then whatever the user wrote in the task's notes on a phone. */
	private notesWithBacklink(file: TFile, notes: string | undefined): string {
		const own = (notes ?? '').trim();
		return own ? `${this.backlink(file)}\n\n${own}` : this.backlink(file);
	}

	private async importNote(r: Remote): Promise<string> {
		const folder = normalizePath(`${this.host.settings.projectsFolder}/${r.project}/tasks`);
		if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
		const title = (r.task.title ?? '').trim() || 'Untitled task';
		const path = await this.freePath(folder, title, null);
		const today = new Date().toISOString().slice(0, 10);
		const due = (r.task.due ?? '').slice(0, 10);
		const lines = [
			'---',
			'type: Task',
			`title: ${JSON.stringify(title)}`,
			'description: ""',
			'resources: []',
			'tags: []',
			`status: ${r.task.status === 'completed' ? 'done' : 'backlog'}`,
			`due: ${due}`,
			'blocked_by: ',
			`google_task_id: ${r.task.id}`,
			`created: ${today}`,
			`modified: ${today}`,
			'---',
			'',
		];
		const file = await this.app.vault.create(path, lines.join('\n'));
		await this.host.google.call(
			'PATCH',
			`${API}/lists/${enc(r.listId)}/tasks/${enc(r.task.id)}`,
			{ body: { notes: this.notesWithBacklink(file, r.task.notes) } },
		);
		return file.path;
	}

	/** `<folder>/<title>.md`, adding " 2", " 3", … while another file owns the path. */
	private async freePath(folder: string, title: string, self: TFile | null): Promise<string> {
		const base = safeFileName(title);
		for (let n = 1; ; n++) {
			const path = normalizePath(`${folder}/${base}${n > 1 ? ` ${n}` : ''}.md`);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (!existing || existing === self) return path;
		}
	}
}

function enc(s: string): string {
	return encodeURIComponent(s);
}
