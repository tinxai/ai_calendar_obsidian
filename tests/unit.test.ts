import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setRequestUrl } from 'obsidian';
import { Auth, AuthError } from '../src/auth';
import { Cache, type CalendarCache } from '../src/cache';
import { CalendarSync, fromGoogle, type GoogleEvent, toGoogle } from '../src/calendar';
import { decrypt, encrypt, isEncrypted } from '../src/crypto';
import { GoogleClient, GoogleError } from '../src/google';
import { DEFAULT_SETTINGS, type GCalSettings, loadSettings } from '../src/settings';
import { backlinkPath, canonicalPath, linksToNote, mergeFields, safeFileName } from '../src/tasks';
import { parseOptions } from '../src/view';

test('loadSettings keeps defaults and drops malformed values', () => {
	assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
	const s = loadSettings({
		clientId: 'id',
		syncIntervalMinutes: 0,
		weekStart: 'someday',
		calendars: { a: { name: 'A' }, b: 'junk' },
		taskLists: { p: 'l1', q: 2 },
	});
	assert.equal(s.clientId, 'id');
	assert.equal(s.syncIntervalMinutes, 5);
	assert.equal(s.weekStart, 'monday');
	assert.deepEqual(s.calendars, {
		a: { name: 'A', color: '', enabled: true },
	});
	assert.deepEqual(s.taskLists, { p: 'l1' });
	assert.notEqual(
		s.calendars,
		DEFAULT_SETTINGS.calendars,
		'defaults are not shared by reference',
	);
});

test('parseOptions validates each option', () => {
	assert.deepEqual(parseOptions(''), {
		view: 'month',
		height: 'auto',
		calendars: [],
		tasks: true,
	});
	assert.deepEqual(parseOptions('view: week\nheight: 500px\ncalendars: [a, b]\ntasks: false'), {
		view: 'week',
		height: '500px',
		calendars: ['a', 'b'],
		tasks: false,
	});
	assert.deepEqual(parseOptions('view: list'), {
		view: 'list',
		height: 'auto',
		calendars: [],
		tasks: true,
	});
	assert.match(parseOptions('view: year') as string, /view/);
	assert.match(parseOptions('tasks: yes') as string, /tasks/);
	assert.match(parseOptions('calendars: 3') as string, /calendars/);
});

test('event mapping between Google and the cache', () => {
	const allDay = fromGoogle('c', {
		id: '1',
		summary: ' ',
		start: { date: '2026-09-01' },
		end: { date: '2026-09-03' },
		etag: '"e"',
		location: '본사 3층 회의실',
	});
	assert.deepEqual(allDay, {
		id: '1',
		calendarId: 'c',
		title: '(No title)',
		start: '2026-09-01',
		end: '2026-09-03',
		allDay: true,
		description: '',
		location: '본사 3층 회의실',
		recurringEventId: null,
		etag: '"e"',
		colorId: '',
		eventLabelId: '',
		attendees: [],
	});
	const timed = fromGoogle('c', {
		id: '2',
		summary: 'T',
		start: { dateTime: '2026-09-01T10:00:00+09:00' },
		end: { dateTime: '2026-09-01T11:00:00+09:00' },
		recurringEventId: 'r',
	});
	assert.equal(timed.allDay, false);
	assert.equal(timed.recurringEventId, 'r');
	assert.equal(timed.location, '');
	assert.deepEqual(
		toGoogle(
			{
				title: 'x',
				start: '2026-09-01',
				end: '2026-09-02',
				allDay: true,
			},
			false,
		),
		{
			summary: 'x',
			start: { date: '2026-09-01' },
			end: { date: '2026-09-02' },
		},
	);
	assert.deepEqual(
		toGoogle(
			{
				start: '2026-09-01T10:00:00Z',
				end: '2026-09-01T11:00:00Z',
				allDay: false,
			},
			true,
		),
		{
			start: { dateTime: '2026-09-01T10:00:00Z', date: null },
			end: { dateTime: '2026-09-01T11:00:00Z', date: null },
		},
	);
	assert.deepEqual(toGoogle({ description: '' }, true), { description: '' });
	assert.deepEqual(toGoogle({ location: '본사 3층 회의실' }, true), {
		location: '본사 3층 회의실',
	});
	assert.deepEqual(toGoogle({ location: '' }, true), { location: '' });
	assert.deepEqual(toGoogle({ title: 'x' }, true), { summary: 'x' });
});

test('crypto: passphrase round trip, wrong passphrase rejected, fresh salt and IV each time', async () => {
	const enc = await encrypt('1//0refresh-token', 'correct horse');
	assert.ok(isEncrypted(enc) && !isEncrypted('1//0refresh-token'));
	assert.doesNotMatch(enc, /refresh/);
	assert.equal(await decrypt(enc, 'correct horse'), '1//0refresh-token');
	await assert.rejects(decrypt(enc, 'wrong'));
	await assert.rejects(decrypt('enc1.broken', 'correct horse'));
	assert.notEqual(await encrypt('x', 'p'), await encrypt('x', 'p'));
});

/** A plugin stand-in with one device's keychain; `settings` is the shared data.json that vault sync would carry. */
function fakePlugin(settings: GCalSettings) {
	const keychain = new Map<string, string>();
	return {
		settings,
		saved: 0,
		app: {
			secretStorage: {
				getSecret: (id: string) => keychain.get(id) ?? null,
				setSecret: (id: string, v: string) => keychain.set(id, v),
			},
		},
		saveSettings() {
			this.saved++;
			return Promise.resolve();
		},
		notifyChanged() {},
		cache: { clearAll() {}, clearTasks() {} },
	};
}

test('Auth: a passphrase encrypts the stored login, a second device unlocks it with the same passphrase', async () => {
	const settings: GCalSettings = {
		...DEFAULT_SETTINGS,
		clientId: 'id',
		clientSecret: 'sec',
		refreshToken: 'plain-token',
	};
	const desktop = fakePlugin(settings);
	const auth = new Auth(desktop as never);
	assert.equal(await auth.unlock(), true, 'plain-text login from an earlier version still works');
	assert.ok(auth.plain && !auth.locked);
	await auth.setPassphrase('  pw  ');
	assert.ok(isEncrypted(settings.refreshToken) && !auth.plain && !auth.locked);
	assert.equal(desktop.app.secretStorage.getSecret('google-cal-sync-passphrase'), 'pw');
	assert.equal(desktop.saved, 1);

	const phone = fakePlugin(settings);
	const other = new Auth(phone as never);
	assert.equal(await other.unlock(), false, 'no passphrase on this device');
	assert.ok(other.loggedIn && other.locked);
	await assert.rejects(
		other.setPassphrase('nope'),
		(e: unknown) => e instanceof AuthError && /Wrong/.test(e.message),
	);
	assert.ok(other.locked);
	await other.setPassphrase('pw');
	assert.ok(!other.locked);
	assert.equal(phone.saved, 0, 'unlocking writes nothing to data.json');

	let sent = '';
	setRequestUrl(async (req) => {
		sent = String(req.body);
		return {
			status: 200,
			text: '{"access_token":"at","expires_in":3600}',
			headers: {},
		};
	});
	assert.equal(await other.token(), 'at');
	assert.match(sent, /refresh_token=plain-token/, 'the decrypted token is what Google receives');

	await other.logout();
	assert.equal(settings.refreshToken, '');
	assert.ok(!other.loggedIn && !other.locked);
});

test('safeFileName strips characters Obsidian rejects', () => {
	assert.equal(safeFileName('a/b: c*?"<>|#^[d]'), 'a b c d');
	assert.equal(safeFileName('   '), 'Untitled task');
});

test('back-links mark tasks made from a note and name that note', () => {
	const link = 'obsidian://open?vault=My%20Vault&file=10-projects%2FARGOS%2Ftasks%2FA%20B';
	assert.equal(linksToNote(link), true);
	assert.equal(linksToNote(`${link}\n\nwritten on the phone`), true);
	assert.equal(linksToNote('call the bank'), false);
	assert.equal(linksToNote(undefined), false);
	assert.equal(backlinkPath(link), '10-projects/ARGOS/tasks/A B.md');
	assert.equal(backlinkPath(`${link}\n\nwritten on the phone`), '10-projects/ARGOS/tasks/A B.md');
	assert.equal(backlinkPath('call the bank'), '');
});

test('every device keeps the same note when several claim one task', () => {
	const paths = ['t/A (1).md', 't/A.md', 't/A (conflict 2026-10-01).md'];
	assert.equal(canonicalPath(paths, 't/A.md'), 't/A.md', 'the note the task links to');
	assert.equal(canonicalPath(paths, 't/gone.md'), [...paths].sort()[0], 'else the first path');
	assert.equal(
		canonicalPath([...paths].reverse(), ''),
		canonicalPath(paths, ''),
		'order does not matter',
	);
});

test('mergeFields takes each field from the side that changed it', () => {
	const base = { title: 'T', due: '2026-10-01', done: false };
	// Phone completed the task while another device moved the due date in the note: both survive.
	assert.deepEqual(
		mergeFields({ ...base, due: '2026-10-05' }, { ...base, done: true }, base, false),
		{ pull: { done: true }, push: { due: '2026-10-05' } },
	);
	assert.deepEqual(
		mergeFields({ ...base, due: '2026-10-05' }, { ...base, done: true }, base, true),
		{ pull: { done: true }, push: { due: '2026-10-05' } },
		'which side is newer does not matter when only one side changed a field',
	);
	// Both sides changed the same field: the newer side wins.
	assert.deepEqual(
		mergeFields({ ...base, title: 'note' }, { ...base, title: 'google' }, base, true),
		{
			pull: { title: 'google' },
			push: {},
		},
	);
	assert.deepEqual(
		mergeFields({ ...base, title: 'note' }, { ...base, title: 'google' }, base, false),
		{
			pull: {},
			push: { title: 'note' },
		},
	);
	// No base yet: the newer side wins every differing field, as before.
	assert.deepEqual(
		mergeFields({ ...base, due: '2026-10-05' }, { ...base, done: true }, undefined, true),
		{
			pull: { due: '2026-10-01', done: true },
			push: {},
		},
	);
	assert.deepEqual(mergeFields(base, base, undefined, true), { pull: {}, push: {} });
});

test('Clear cache keeps the task index; logging out drops it', () => {
	const cache = memoryCache();
	cache.saveCalendar('c', { syncToken: 's', syncedAt: 1, events: {} });
	cache.saveTaskIndex({ t1: 'p/tasks/a.md' });
	cache.saveTaskState({ base: { t1: { title: 'a', due: '', done: false } }, absent: {} });
	cache.clearAll(['c']);
	assert.equal(cache.calendar('c'), null);
	assert.deepEqual(cache.taskIndex(), { t1: 'p/tasks/a.md' });
	assert.deepEqual(Object.keys(cache.taskState().base), ['t1']);
	cache.clearTasks();
	assert.deepEqual(cache.taskIndex(), {});
	assert.deepEqual(cache.taskState(), { base: {}, absent: {} });
});

function memoryCache(): Cache {
	const store = new Map<string, unknown>();
	const app = {
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => {
			if (v === null) store.delete(k);
			else store.set(k, JSON.parse(JSON.stringify(v)));
		},
	};
	return new Cache(app as never);
}

test('GoogleClient: query building, 401 retry, error parsing, 204', async () => {
	const calls: Array<Record<string, unknown>> = [];
	let tokens = 0;
	const auth = {
		token: async (force?: boolean) => (force ? `t${++tokens}` : `t${tokens}`),
	};
	setRequestUrl(async (req) => {
		calls.push(req);
		const headers = req.headers as Record<string, string>;
		if (headers.Authorization === 'Bearer t0')
			return {
				status: 401,
				text: '{"error":{"message":"expired"}}',
				headers: {},
			};
		if (String(req.url).includes('/boom'))
			return {
				status: 403,
				text: '{"error":{"message":"Forbidden thing"}}',
				headers: {},
			};
		if (req.method === 'DELETE') return { status: 204, text: '', headers: {} };
		return { status: 200, text: '{"ok":true}', headers: {} };
	});
	const g = new GoogleClient(auth);
	const r = await g.call<{ ok: boolean }>('GET', 'https://x/y', {
		query: { a: 1, b: undefined, c: '', d: 'z' },
	});
	assert.deepEqual(r, { ok: true });
	assert.equal(calls.length, 2, 'one retry after 401');
	assert.equal(calls[1]?.url, 'https://x/y?a=1&d=z');
	assert.equal(
		(calls[1]?.headers as Record<string, string> | undefined)?.Authorization,
		'Bearer t1',
	);
	await assert.rejects(
		g.call('GET', 'https://x/boom'),
		(e: unknown) =>
			e instanceof GoogleError && e.status === 403 && e.message === 'Forbidden thing',
	);
	assert.equal(await g.call('DELETE', 'https://x/y'), undefined);
});

test('CalendarSync: full sync, incremental with cancelled, 410 resync, pagination', async () => {
	const pages: Array<{
		items?: GoogleEvent[];
		nextPageToken?: string;
		nextSyncToken?: string;
	}> = [];
	const urls: string[] = [];
	let fail410 = false;
	setRequestUrl(async (req) => {
		if (!String(req.url).includes('/events'))
			return {
				status: 200,
				text: JSON.stringify({ labelProperties: { eventLabels: [] } }),
				headers: {},
			};
		urls.push(String(req.url));
		if (fail410 && String(req.url).includes('syncToken='))
			return {
				status: 410,
				text: '{"error":{"message":"gone"}}',
				headers: {},
			};
		return {
			status: 200,
			text: JSON.stringify(pages.shift() ?? {}),
			headers: {},
		};
	});
	const cache = memoryCache();
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	const ev = (id: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
		id,
		summary: id,
		start: { date: '2026-09-01' },
		end: { date: '2026-09-02' },
		...extra,
	});

	pages.push(
		{ items: [ev('a')], nextPageToken: 'p2' },
		{ items: [ev('b')], nextSyncToken: 'S1' },
	);
	let state: CalendarCache = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events).sort(), ['a', 'b']);
	assert.equal(state.syncToken, 'S1');
	assert.match(urls[0] ?? '', /timeMin=.*timeMax=/);
	assert.match(urls[1] ?? '', /pageToken=p2/);
	assert.doesNotMatch(urls[0] ?? '', /syncToken/);

	pages.push({
		items: [ev('a', { status: 'cancelled' }), ev('c')],
		nextSyncToken: 'S2',
	});
	state = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events).sort(), ['b', 'c']);
	assert.match(urls[2] ?? '', /syncToken=S1/);
	assert.doesNotMatch(urls[2] ?? '', /timeMin/);

	fail410 = true;
	pages.push({ items: [ev('z')], nextSyncToken: 'S3' });
	state = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events), ['z'], 'cache rebuilt from the full sync');
	assert.equal(state.syncToken, 'S3');
	assert.match(urls[3] ?? '', /syncToken=S2/);
	assert.match(urls[4] ?? '', /timeMin=/);
});

test('CalendarSync.patch: 412 refreshes the cache and rethrows', async () => {
	setRequestUrl(async (req) => {
		if (req.method === 'PATCH')
			return {
				status: 412,
				text: '{"error":{"message":"Precondition Failed"}}',
				headers: {},
			};
		return {
			status: 200,
			text: JSON.stringify({
				id: 'e',
				summary: 'fresh',
				etag: '"2"',
				start: { date: '2026-09-01' },
				end: { date: '2026-09-02' },
			}),
			headers: {},
		};
	});
	const cache = memoryCache();
	cache.saveCalendar('cal', {
		syncToken: 's',
		syncedAt: 1,
		events: {
			e: {
				id: 'e',
				calendarId: 'cal',
				title: 'old',
				start: '2026-09-01',
				end: '2026-09-02',
				allDay: true,
				description: '',
				recurringEventId: null,
				etag: '"1"',
			},
		},
	});
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	await assert.rejects(
		sync.patch('cal', 'e', '"1"', { title: 'mine' }),
		(e: unknown) => e instanceof GoogleError && e.status === 412,
	);
	assert.equal(cache.calendar('cal')?.events.e?.title, 'fresh');
	assert.equal(cache.calendar('cal')?.events.e?.etag, '"2"');
});

test('date helpers: date-only parsing stays local, day arithmetic crosses months, offsets are explicit', async () => {
	const { addDays, fmtDate, fmtLocal, fmtTime, fromNow, parseDate, parseLocal } = await import(
		'../src/dates'
	);
	assert.equal(
		fmtDate(parseDate('2026-09-23')),
		'2026-09-23',
		'no UTC shift for date-only strings',
	);
	assert.equal(addDays('2026-09-30', 1), '2026-10-01');
	assert.equal(addDays('2026-01-01', -1), '2025-12-31');
	const d = parseLocal('2026-09-10', '10:05');
	assert.equal(fmtTime(d), '10:05');
	assert.match(fmtLocal(d), /^2026-09-10T10:05:00[+-]\d{2}:\d{2}$/);
	assert.ok(Number.isNaN(parseLocal('2026-09-10', '').getTime()));
	assert.equal(fromNow(Date.now() - 2 * 3_600_000), '2h ago');
	assert.equal(fromNow(Date.now() - 30_000), 'just now');
	assert.equal(fromNow(Date.now() - 86_400_000), '1d ago');
});

test('createEvent input becomes the prefill an empty-slot click gives, and bad input is rejected', async () => {
	const { createParams } = await import('../src/api');
	const { fmtLocal, parseLocal } = await import('../src/dates');
	const cals = { primary: { name: 'Me', color: '', enabled: true } };
	assert.deepEqual(createParams({ date: '2026-10-31' }, cals), {
		calendarId: undefined,
		allDay: true,
		start: '2026-10-31',
		end: '2026-11-01',
	});
	assert.deepEqual(
		createParams(
			{ date: '2026-10-15', start: '09:30', end: '11:00', calendarId: 'primary' },
			cals,
		),
		{
			calendarId: 'primary',
			allDay: false,
			start: fmtLocal(parseLocal('2026-10-15', '09:30')),
			end: fmtLocal(parseLocal('2026-10-15', '11:00')),
		},
	);
	assert.equal(createParams({ date: '2026-10-15', start: '09:30' }, cals).end, undefined);
	for (const [init, msg] of [
		[{ date: '2026-13-01' }, /date/],
		[{ date: '15.10.2026' }, /date/],
		[{ date: '2026-10-15', start: '9:30' }, /start/],
		[{ date: '2026-10-15', start: '25:00' }, /start/],
		[{ date: '2026-10-15', end: '10:00' }, /end needs/],
		[{ date: '2026-10-15', start: '10:00', end: '09:00' }, /before/],
		[{ date: '2026-10-15', calendarId: 'nope' }, /Unknown calendar/],
	] as const)
		assert.throws(() => createParams(init, cals), msg);
});

test('blockedMessage names what keeps the calendar from drawing', async () => {
	const { blockedMessage } = await import('../src/view');
	const plugin = (settings: Partial<GCalSettings>, locked = false) =>
		({
			settings: { ...DEFAULT_SETTINGS, ...settings },
			auth: { locked },
		}) as unknown as Parameters<typeof blockedMessage>[0];
	const ready = { clientId: 'id', clientSecret: 's', refreshToken: 'enc1.x' };
	assert.match(blockedMessage(plugin({})), /client ID/);
	assert.match(blockedMessage(plugin({ ...ready, refreshToken: '' })), /Log in/);
	assert.match(blockedMessage(plugin(ready, true)), /passphrase/);
	assert.equal(blockedMessage(plugin(ready)), '');
});

test('calendar colours map from the classic API palette to the modern one', async () => {
	const { modernColor } = await import('../src/colors');
	assert.equal(modernColor('#9fe1e7'), '#039be5');
	assert.equal(modernColor('#92E1C0'), '#33b679');
	assert.equal(modernColor('#123456'), '#123456', 'custom colours pass through');
});

test('event colors use custom labels, modern legacy colors, then the calendar default', async () => {
	const { eventColor } = await import('../src/event-colors');
	const labels = [{ id: 'custom', backgroundColor: '#123abc' }];
	assert.equal(
		eventColor({ colorId: '11', eventLabelId: 'custom' }, labels, '#000000'),
		'#123abc',
	);
	assert.equal(eventColor({ colorId: '11' }, [], '#000000'), '#d50000');
	assert.equal(eventColor({ colorId: '' }, labels, '#000000'), '#000000');
	assert.equal(
		eventColor({ colorId: '', eventLabelId: 'deleted' }, labels, '#000000'),
		'#000000',
	);
	assert.equal(
		fromGoogle('cal', { id: 'e', colorId: '5', eventLabelId: 'custom' }).eventLabelId,
		'custom',
	);
	assert.deepEqual(toGoogle({ eventLabelId: '' }, true), { eventLabelId: '' });
});

test('color migration refetches unchanged events once and refreshes labels during incremental sync', async () => {
	const { eventColor } = await import('../src/event-colors');
	const cache = memoryCache();
	cache.saveCalendar('cal', {
		syncToken: 'old-token',
		syncedAt: 1,
		events: { e: fromGoogle('cal', { id: 'e' }) },
	});
	let hex = '#123abc';
	let eventRequests = 0;
	setRequestUrl(async (req) => {
		const url = String(req.url);
		if (!url.includes('/events'))
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					labelProperties: { eventLabels: [{ id: 'label', backgroundColor: hex }] },
				}),
			};
		assert.match(url, /eventLabelVersion=1/);
		eventRequests++;
		if (eventRequests === 1) {
			assert.doesNotMatch(url, /syncToken/);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					items: [{ id: 'e', eventLabelId: 'label' }],
					nextSyncToken: 'new-token',
				}),
			};
		}
		assert.match(url, /syncToken=new-token/);
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({ items: [], nextSyncToken: 'next-token' }),
		};
	});
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	let state = await sync.sync('cal');
	assert.equal(state.colorVersion, 1);
	assert.ok(state.events.e);
	assert.equal(eventColor(state.events.e, state.labels), '#123abc');
	hex = '#abcdef';
	state = await sync.sync('cal');
	assert.ok(state.events.e);
	assert.equal(eventColor(state.events.e, state.labels), '#abcdef');
	assert.equal(state.events.e?.eventLabelId, 'label');
});

test('moving a custom-colored event preserves its label; an explicit color choice overrides it', async () => {
	const cache = memoryCache();
	cache.saveCalendar('cal', {
		syncToken: 's',
		syncedAt: 1,
		events: { e: fromGoogle('cal', { id: 'e', eventLabelId: 'custom' }) },
	});
	let count = 0;
	setRequestUrl(async (req) => {
		const body = JSON.parse(String(req.body));
		if (++count === 1) {
			assert.match(String(req.url), /eventLabelVersion=1/);
			assert.equal(body.eventLabelId, 'custom');
			assert.equal(body.colorId, undefined);
		} else {
			assert.equal(body.eventLabelId, '');
		}
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({ id: 'e', eventLabelId: body.eventLabelId }),
		};
	});
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	await sync.patch('cal', 'e', '', { title: 'Moved event' });
	await sync.patch('cal', 'e', '', { eventLabelId: '' });
	assert.equal(cache.calendar('cal')?.events.e?.eventLabelId, '');
});

test('planning periods use local dates and ISO week years across New Year', async () => {
	const { planPeriod } = await import('../src/planner-model');
	assert.deepEqual(planPeriod(new Date(2026, 9, 23, 12)), {
		year: '2026',
		month: '2026-10',
		week: '2026-W43',
		start: '2026-10-19',
		end: '2026-10-25',
	});
	assert.equal(planPeriod(new Date(2027, 0, 1, 12)).week, '2026-W53');
	assert.equal(planPeriod(new Date(2025, 11, 29, 12)).week, '2026-W01');
});

test('planning progress counts only deliverables, ignoring routines, review prompts and code', async () => {
	const { planProgress } = await import('../src/planner-model');
	const text =
		'# Week\n## Commitments\n- [x] Deploy demo\n- [ ] Finish login\n```md\n- [x] Example\n```\n## Routines\n- [x] Lunch\n## Weekly review\n- [ ] What did I finish?';
	assert.deepEqual(planProgress(text, 'Commitments'), { done: 1, total: 2 });
	assert.deepEqual(planProgress(text, 'Milestones'), { done: 0, total: 0 });
});

test('planning replies reject traversal, non-plan writes, duplicate edits and malformed content', async () => {
	const { parsePlannerReply } = await import('../src/planner-model');
	assert.deepEqual(parsePlannerReply('{"message":"No goals set yet.","edits":[]}').edits, []);
	for (const path of [
		'../secret.md',
		'Plans/Weekly/../../secret.md',
		'Plans/Plan interview.md',
		'.obsidian/data.json',
		'Plans/Weekly/2026-W99.md',
	]) {
		assert.throws(() =>
			parsePlannerReply(
				JSON.stringify({ message: 'x', edits: [{ path, content: '# Plan' }] }),
			),
		);
	}
	const edit = { path: 'Plans/Planner Board.canvas', content: '{"nodes":[],"edges":[]}' };
	assert.throws(() => parsePlannerReply(JSON.stringify({ message: 'x', edits: [edit, edit] })));
	assert.throws(() =>
		parsePlannerReply(JSON.stringify({ message: 'x', edits: [{ ...edit, content: '' }] })),
	);
	assert.equal(
		parsePlannerReply(JSON.stringify({ message: 'Saved', edits: [edit] })).edits[0]?.path,
		edit.path,
	);
});

test('planning store saves Excalidraw text with backups and rejects concurrent text changes', async () => {
	const { TFile } = await import('obsidian');
	const { PlannerStore } = await import('../src/planner-store');
	const { planPeriod } = await import('../src/planner-model');
	const { parsePlannerCanvas } = await import('../src/planner-canvas');
	const { parsePlannerDrawing, drawingPlan } = await import('../src/planner-excalidraw');
	const files = new Map<string, InstanceType<typeof TFile> | { path: string }>();
	const contents = new Map<string, string>();
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			createFolder: async (path: string) => {
				files.set(path, { path });
			},
			create: async (path: string, content: string) => {
				assert(!files.has(path));
				const file = new TFile();
				file.path = path;
				files.set(path, file);
				contents.set(path, content);
				return file;
			},
			read: async (file: { path: string }) => contents.get(file.path) ?? '',
			process: async (file: { path: string }, fn: (text: string) => string) => {
				contents.set(file.path, fn(contents.get(file.path) ?? ''));
			},
		},
	};
	const store = new PlannerStore(app as never);
	const period = planPeriod(new Date(2026, 9, 23));
	await Promise.all([store.ensure(period), store.ensure(period)]);
	const path = 'Plans/Planner Board.excalidraw.md';
	const original = contents.get(path) ?? '';
	const snapshot = await store.context(period);
	const next = parsePlannerCanvas(snapshot[0]?.content ?? '');
	const week = next.nodes.find((node) => node.text?.includes('This week'));
	assert(week);
	week.text += '\n- [ ] Deploy demo';
	await store.apply([{ path, content: JSON.stringify(next) }], snapshot);
	assert.match(contents.get(path) ?? '', /Deploy demo/);
	assert(
		[...contents.entries()].some(
			([key, value]) => key.startsWith('Plans/History/') && value === original,
		),
	);
	await assert.rejects(
		store.apply([{ path, content: JSON.stringify(next) }], snapshot),
		/card changed/,
	);
	assert.equal(snapshot.length, 1);
	assert.equal(snapshot[0]?.path, path);
	assert(!files.has('Plans/Planner.md'));
	await store.ensure(planPeriod(new Date(2026, 9, 26)));
	assert.match(contents.get(path) ?? '', /This week · 2026-W44/);
	assert.equal(
		(
			JSON.stringify(drawingPlan(parsePlannerDrawing(contents.get(path) ?? ''))).match(
				/Deploy demo/g,
			) ?? []
		).length,
		1,
	);
});

test('planning CLI sends context through stdin with tools disabled and parses structured output', async () => {
	const fs = await import('node:fs');
	const fsp = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const { EventEmitter } = await import('node:events');
	const { askPlanningCodex } = await import('../src/planner-ai');
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	let prompt = '',
		directory = '',
		ran = false;
	const fakeSpawn = (
		_executable: string,
		args: string[],
		options: { cwd: string; shell: boolean },
	) => {
		ran = true;
		directory = options.cwd;
		assert.equal(options.shell, false);
		assert(args.includes('--ignore-user-config'));
		assert(args.includes('--ephemeral'));
		assert(args.includes('read-only'));
		assert(args.includes('shell_tool'));
		assert(args.includes('multi_agent'));
		const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {
			stderr: InstanceType<typeof EventEmitter>;
			stdin: { on: () => void; end: (text: string) => void };
			kill: () => void;
		};
		child.stderr = new EventEmitter();
		child.stdin = {
			on: () => {},
			end: (text) => {
				prompt = text;
				const output = args[args.indexOf('--output-last-message') + 1] ?? '';
				void fsp
					.writeFile(output, '{"message":"No commitments recorded yet.","edits":[]}')
					.then(() => child.emit('close', 0));
			},
		};
		child.kill = () => {
			child.emit('close', null);
		};
		return child;
	};
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			setTimeout,
			clearTimeout,
			require: (name: string) => {
				if (name === 'node:fs') return { ...fs, existsSync: () => true };
				if (name === 'node:fs/promises') return fsp;
				if (name === 'node:os') return os;
				if (name === 'node:path') return path;
				if (name === 'node:process') return { env: {} };
				if (name === 'node:child_process') return { spawn: fakeSpawn };
				throw new Error(`Unexpected module ${name}`);
			},
		},
	});
	try {
		const reply = await askPlanningCodex('Review only the supplied plans.').result;
		assert(ran);
		assert.equal(prompt, 'Review only the supplied plans.');
		assert.equal(reply.message, 'No commitments recorded yet.');
		assert.equal(fs.existsSync(directory), false, 'temporary context and reply are removed');
	} finally {
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('manual gray event colors are completion evidence; calendar defaults and missing palettes are not', async () => {
	const { calendarCompletion } = await import('../src/planner-calendar');
	const event = fromGoogle('cal', { id: 'work', colorId: '8' });
	assert.equal(calendarCompletion(event).completion, 'completed');
	assert.equal(calendarCompletion({ ...event, colorId: '' }).completion, 'not_marked_complete');
	assert.equal(calendarCompletion({ ...event, colorId: '10' }).completion, 'not_marked_complete');
	for (const color of ['#616161', '#e1e1e1', '#5B5B5B', '#808080']) {
		assert.equal(
			calendarCompletion({ ...event, eventLabelId: 'custom' }, [
				{ id: 'custom', backgroundColor: color },
			]).completion,
			'completed',
		);
	}
	for (const color of ['#ffffff', '#000000', '#0b8043']) {
		assert.equal(
			calendarCompletion({ ...event, eventLabelId: 'custom' }, [
				{ id: 'custom', backgroundColor: color },
			]).completion,
			'not_marked_complete',
		);
	}
	assert.equal(
		calendarCompletion({ ...event, eventLabelId: 'missing' }).completion,
		'unknown_color',
	);
	assert.equal(calendarCompletion({ ...event, colorId: 'unknown' }).completion, 'unknown_color');
});

test('weekly completion snapshot respects exclusive ends, disabled calendars and recurring occurrence IDs', async () => {
	const { planningCalendarSnapshot } = await import('../src/planner-calendar');
	const { planPeriod } = await import('../src/planner-model');
	const period = planPeriod(new Date(2026, 9, 23, 12));
	const events = {
		a: fromGoogle('cal', {
			id: 'occurrence-1',
			colorId: '8',
			start: { dateTime: '2026-10-19T09:00:00' },
			end: { dateTime: '2026-10-19T10:00:00' },
			recurringEventId: 'series',
		}),
		b: fromGoogle('cal', {
			id: 'occurrence-2',
			colorId: '10',
			start: { dateTime: '2026-10-20T09:00:00' },
			end: { dateTime: '2026-10-20T10:00:00' },
			recurringEventId: 'series',
		}),
		prior: fromGoogle('cal', {
			id: 'prior',
			colorId: '8',
			start: { date: '2026-10-18' },
			end: { date: '2026-10-19' },
		}),
		next: fromGoogle('cal', {
			id: 'next',
			colorId: '8',
			start: { date: '2026-10-26' },
			end: { date: '2026-10-27' },
		}),
		sunday: fromGoogle('cal', {
			id: 'sunday',
			colorId: '8',
			start: { date: '2026-10-25' },
			end: { date: '2026-10-26' },
		}),
	};
	const cache = { syncToken: 's', syncedAt: 123, events };
	const calendar = { id: 'cal', name: 'Work', enabled: true, cache };
	const snapshot = planningCalendarSnapshot(
		[calendar, { ...calendar, id: 'disabled', enabled: false }],
		period,
		123,
		'Offline',
	);
	assert.equal(snapshot.total, 3);
	assert.equal(snapshot.completed, 2);
	assert.equal(snapshot.notMarkedComplete, 1);
	assert.equal(snapshot.syncError, 'Offline');
	assert.equal(snapshot.lastSyncedAt, 123);
	assert.deepEqual(
		snapshot.slots.map((slot) => slot.id),
		['occurrence-1', 'occurrence-2', 'sunday'],
	);
	events.a.colorId = '10';
	assert.equal(
		planningCalendarSnapshot([calendar], period, 124).completed,
		1,
		'recoloring withdraws that completion evidence',
	);
});

test('custom completion labels override legacy colors and snapshots disclose omitted events', async () => {
	const { planningCalendarSnapshot } = await import('../src/planner-calendar');
	const { planPeriod } = await import('../src/planner-model');
	const events = Object.fromEntries(
		Array.from({ length: 301 }, (_, index) => {
			const event = fromGoogle('cal', {
				id: String(index),
				colorId: '8',
				eventLabelId: 'label',
				start: { date: '2026-10-23' },
				end: { date: '2026-10-24' },
			});
			return [event.id, event];
		}),
	);
	const calendar = {
		id: 'cal',
		name: 'Work',
		enabled: true,
		cache: {
			syncToken: 's',
			syncedAt: 1,
			events,
			labels: [{ id: 'label', backgroundColor: '#0b8043' }],
		},
	};
	const period = planPeriod(new Date(2026, 9, 23));
	let snapshot = planningCalendarSnapshot([calendar], period, 1);
	assert.equal(snapshot.completed, 0);
	assert.equal(snapshot.notMarkedComplete, 301);
	assert.equal(snapshot.slots.length, 300);
	assert.equal(snapshot.omitted, 1);
	calendar.cache.labels[0] = { id: 'label', backgroundColor: '#808080' };
	snapshot = planningCalendarSnapshot([calendar], period, 2);
	assert.equal(snapshot.completed, 301);
});

test('planning prompt compares gray completion with linked plans without silently changing notes', async () => {
	const { plannerPrompt, planPeriod } = await import('../src/planner-model');
	const prompt = plannerPrompt('Review my progress', [], [], planPeriod(new Date(2026, 9, 23)), {
		completed: 2,
	});
	assert.match(prompt, /MANUALLY change finished Google Calendar events to gray/);
	assert.match(prompt, /Reviews leave notes unchanged/);
	assert.match(prompt, /not that an entire app or yearly goal is achieved/);
	assert.match(prompt, /"completed":2/);
});

test('single planner columns count separately and the prompt includes interview planning', async () => {
	const { planProgress, plannerPrompt, planPeriod, plannerSections } = await import(
		'../src/planner-model'
	);
	const period = planPeriod(new Date(2026, 9, 23));
	const text =
		'---\nkanban-plugin: board\n---\n\n## Yearly plan · 2026\n- [ ] Publish app\n## Monthly plan · 2026-10\n- [x] Finish prototype\n## This week · 2026-W43\n- [x] Deploy demo\n- [ ] Finish login\n## Interview plan\n- [ ] Practice ML system design\n## Recurring / breaks\n- [x] Lunch\n\n%% kanban:settings\n```\n{"kanban-plugin":"board"}\n```\n%%';
	assert.deepEqual(
		plannerSections(period).map((section) => planProgress(text, section.heading)),
		[
			{ done: 0, total: 1 },
			{ done: 1, total: 1 },
			{ done: 1, total: 2 },
			{ done: 0, total: 1 },
		],
	);
	const prompt = plannerPrompt(
		'Update interview preparation',
		[{ path: 'Plans/Planner.md', content: text }],
		[],
		period,
	);
	assert.match(prompt, /ONE visual planner document/);
	assert.match(prompt, /Never create Planner.md, dated plan folders, separate interview notes/);
	assert.match(prompt, /There is NO backing Planner.md/);
	assert.match(prompt, /Practice ML system design/);
});

test('consolidation cleanup removes only exact retired placeholders and preserves edited notes', async () => {
	const { TFile } = await import('obsidian');
	const { PlannerStore } = await import('../src/planner-store');
	const { planPeriod, plannerSections } = await import('../src/planner-model');
	const period = planPeriod(new Date(2026, 9, 23));
	const notes = new Map<string, string>([
		[
			'Plans/Planner Board.canvas',
			JSON.stringify({
				nodes: plannerSections(period).map((section, index) => ({
					id: String(index),
					type: 'text',
					text: `## ${section.heading}`,
					x: 0,
					y: index * 500,
					width: 720,
					height: 400,
				})),
				edges: [],
			}),
		],
		['Plans/Yearly/2026.md', 'exact old placeholder'],
		['Plans/Monthly/2026-10.md', 'user edited this note'],
	]);
	const manifest = {
		complete: false,
		entries: [
			{ path: 'Plans/Yearly/2026.md', content: 'exact old placeholder' },
			{ path: 'Plans/Monthly/2026-10.md', content: 'old monthly placeholder' },
			{
				path: 'Plans/Planner Board.canvas',
				content: notes.get('Plans/Planner Board.canvas'),
			},
		],
	};
	let saved = '';
	const app = {
		vault: {
			configDir: '.obsidian',
			adapter: {
				exists: async () => true,
				read: async () => JSON.stringify(manifest),
				write: async (_path: string, text: string) => {
					saved = text;
				},
			},
			getAbstractFileByPath: (path: string) => {
				if (!notes.has(path)) return null;
				const file = new TFile();
				file.path = path;
				return file;
			},
			read: async (file: { path: string }) => notes.get(file.path) ?? '',
			delete: async (file: { path: string }) => {
				notes.delete(file.path);
			},
		},
	};
	await new PlannerStore(app as never).ensure(period);
	assert(!notes.has('Plans/Yearly/2026.md'));
	assert.equal(notes.get('Plans/Monthly/2026-10.md'), 'user edited this note');
	assert(notes.has('Plans/Planner Board.canvas'));
	assert.equal(JSON.parse(saved).complete, true);
	assert.match(saved, /exact old placeholder/);
});

test('planner navigation pans empty space while preserving card/grip dragging and lane scrolling', async () => {
	const { registerPlannerNavigation } = await import('../src/planner-navigation');
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const view = {};
	const doc = { defaultView: view };
	const cleanups: (() => void)[] = [];
	const listeners: { target: unknown; name: string; fn: (event: never) => void }[] = [];
	const classes = new Set<string>();
	let scrollLeft = 0;
	const board = {
		clientWidth: 600,
		scrollWidth: 1800,
		clientHeight: 500,
		scrollHeight: 500,
		scrollTop: 0,
		get scrollLeft() {
			return scrollLeft;
		},
		set scrollLeft(value: number) {
			scrollLeft = Math.max(0, Math.min(1200, value));
		},
		classList: {
			add: (name: string) => classes.add(name),
			remove: (name: string) => classes.delete(name),
		},
	};
	const target = (blocked = false, editable = false, parent: unknown = board) => ({
		parentElement: parent,
		scrollHeight: 0,
		clientHeight: 0,
		scrollTop: 0,
		classList: { contains: () => false },
		closest(selector: string) {
			if (selector.startsWith('.kanban-plugin__board')) return board;
			if (
				(blocked && selector.includes('.kanban-plugin__lane-wrapper')) ||
				(editable && selector.includes('input'))
			)
				return this;
			return null;
		},
	});
	const owner = {
		register: (fn: () => void) => cleanups.push(fn),
		registerEvent: () => {},
		registerDomEvent: (node: unknown, name: string, fn: (event: never) => void) => {
			const listener = { target: node, name, fn };
			listeners.push(listener);
			cleanups.push(() => listeners.splice(listeners.indexOf(listener), 1));
		},
		app: {
			workspace: {
				iterateAllLeaves: (fn: (leaf: unknown) => void) =>
					fn({ view: { containerEl: { ownerDocument: doc } } }),
				on: () => ({}),
			},
		},
	};
	const fire = (node: unknown, name: string, extras: object = {}) => {
		const event = {
			target: target(),
			pointerType: 'mouse',
			button: 0,
			buttons: 1,
			clientX: 200,
			clientY: 100,
			deltaX: 0,
			deltaY: 100,
			deltaMode: 0,
			defaultPrevented: false,
			prevented: false,
			preventDefault() {
				this.prevented = true;
			},
			stopPropagation() {},
			...extras,
		};
		for (const listener of listeners.filter(
			(entry) => entry.target === node && entry.name === name,
		))
			listener.fn(event as never);
		return event;
	};
	Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
	try {
		registerPlannerNavigation(owner as never);
		assert.equal(
			listeners.filter((listener) => listener.name === 'pointerdown').length,
			1,
			'same document attaches once',
		);
		assert.equal(
			fire(doc, 'pointerdown', { target: target(true) }).prevented,
			false,
			'cards and column handles retain native drag handlers',
		);
		assert.equal(fire(doc, 'pointerdown', { target: target(false, true) }).prevented, false);
		assert.equal(fire(doc, 'pointerdown', { pointerType: 'touch' }).prevented, false);
		assert.equal(fire(doc, 'pointerdown').prevented, true);
		fire(doc, 'pointermove', { clientX: 100 });
		assert.equal(scrollLeft, 100);
		assert(classes.has('planner-is-panning'));
		fire(doc, 'pointerup');
		assert(!classes.has('planner-is-panning'));
		fire(doc, 'wheel');
		assert.equal(scrollLeft, 200);
		const lane = {
			...target(),
			scrollHeight: 600,
			clientHeight: 200,
			scrollTop: 0,
			classList: { contains: () => true },
		};
		const card = target(true, false, lane);
		assert.equal(fire(doc, 'wheel', { target: card }).prevented, false);
		assert.equal(scrollLeft, 200, 'tall lane scrolls vertically');
		lane.scrollTop = 400;
		fire(doc, 'wheel', { target: card });
		assert.equal(scrollLeft, 300, 'at lane edge wheel can navigate the board');
		fire(doc, 'pointerdown', { button: 1, buttons: 4 });
		fire(doc, 'pointermove', { clientX: 250, buttons: 4 });
		assert.equal(scrollLeft, 250);
		fire(view, 'blur');
		assert(!classes.has('planner-is-panning'));
		fire(doc, 'pointerdown');
		for (const cleanup of [...cleanups].reverse()) cleanup();
		assert.equal(listeners.length, 0);
		assert(!classes.has('planner-is-panning'));
	} finally {
		if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
		else Reflect.deleteProperty(globalThis, 'document');
	}
});

test('Canvas text edits preserve current manual layout and connections and reject card deletion', async () => {
	const { parsePlannerCanvas, mergeCanvasText, canvasProgress } = await import(
		'../src/planner-canvas'
	);
	const raw = JSON.stringify({
		nodes: [
			{
				id: 'week',
				type: 'text',
				text: '## This week · 2026-W43\n- [ ] Demo',
				x: 10,
				y: 20,
				width: 720,
				height: 400,
			},
			{
				id: 'year',
				type: 'text',
				text: '## Yearly plan · 2026',
				x: 0,
				y: 0,
				width: 720,
				height: 400,
			},
		],
		edges: [{ id: 'edge', fromNode: 'week', toNode: 'year', label: 'supports' }],
	});
	const original = parsePlannerCanvas(raw),
		proposed = parsePlannerCanvas(raw),
		current = parsePlannerCanvas(raw);
	proposed.nodes[0].text = '## This week · 2026-W43\n- [x] Demo';
	proposed.nodes[0].x = 999;
	current.nodes[0].x = 500;
	current.edges[0].label = 'my new connection label';
	const merged = mergeCanvasText(original, proposed, current);
	assert(merged.changed);
	assert.equal(merged.board.nodes[0].x, 500);
	assert.equal(merged.board.edges[0].label, 'my new connection label');
	assert.deepEqual(canvasProgress(merged.board, 'This week · 2026-W43'), { done: 1, total: 1 });
	const missing = parsePlannerCanvas(raw);
	missing.nodes.pop();
	missing.edges = [];
	assert.throws(
		() => mergeCanvasText(original, missing, parsePlannerCanvas(raw)),
		/existing text cards only/,
	);
	const conflict = parsePlannerCanvas(raw);
	conflict.nodes[0].text = 'User typed a different plan';
	assert.throws(() => mergeCanvasText(original, proposed, conflict), /card changed/);
});

test('planner board font styling is scoped to this Canvas and cleans up when switching files', async () => {
	const { registerPlannerBoardStyle } = await import('../src/planner-board-style');
	const callbacks = new Map<string, () => void>();
	const cleanups: (() => void)[] = [];
	const make = (file: string, type = 'canvas') => {
		const classes = new Set<string>(),
			styles = new Map<string, string>();
		const state = { file };
		const element = {
			ownerDocument: {
				body: {},
				defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '16px' }) },
			},
			classList: {
				toggle: (name: string, enabled: boolean) =>
					enabled ? classes.add(name) : classes.delete(name),
				remove: (name: string) => classes.delete(name),
			},
			style: {
				setProperty: (name: string, value: string) => styles.set(name, value),
				removeProperty: (name: string) => styles.delete(name),
			},
		};
		return {
			state,
			classes,
			styles,
			leaf: {
				view: { containerEl: element, getState: () => state, getViewType: () => type },
			},
		};
	};
	const planner = make('Plans/Planner Board.canvas'),
		other = make('Other.canvas'),
		note = make('Plans/Planning Chat Log.md', 'markdown');
	const plugin = {
		register: (fn: () => void) => cleanups.push(fn),
		registerEvent: () => {},
		app: {
			workspace: {
				iterateAllLeaves: (fn: (leaf: unknown) => void) =>
					[planner, other, note].forEach((entry) => {
						fn(entry.leaf);
					}),
				on: (name: string, fn: () => void) => {
					callbacks.set(name, fn);
					return {};
				},
				onLayoutReady: (fn: () => void) => fn(),
			},
		},
	};
	registerPlannerBoardStyle(plugin as never);
	assert(planner.classes.has('planner-board-large-text'));
	assert.equal(planner.styles.get('--planner-base-font-size'), '16px');
	assert.equal(other.classes.size, 0);
	assert.equal(note.classes.size, 0);
	planner.state.file = 'Other.canvas';
	callbacks.get('file-open')?.();
	assert.equal(planner.classes.size, 0);
	assert.equal(planner.styles.size, 0);
	planner.state.file = 'Plans/Planner Board.canvas';
	callbacks.get('file-open')?.();
	cleanups.forEach((fn) => {
		fn();
	});
	assert.equal(planner.classes.size, 0);
	assert.equal(planner.styles.size, 0);
});

test('Canvas parsing rejects malformed cards and dangling connections', async () => {
	const { parsePlannerCanvas } = await import('../src/planner-canvas');
	const node = { id: 'a', type: 'text', text: 'Plan', x: 0, y: 0, width: 720, height: 400 };
	assert.throws(() => parsePlannerCanvas('{"nodes":null}'));
	assert.throws(() => parsePlannerCanvas(JSON.stringify({ nodes: [node, node], edges: [] })));
	assert.throws(() =>
		parsePlannerCanvas(JSON.stringify({ nodes: [{ ...node, width: -1 }], edges: [] })),
	);
	assert.throws(() =>
		parsePlannerCanvas(
			JSON.stringify({
				nodes: [node],
				edges: [{ id: 'edge', fromNode: 'a', toNode: 'missing' }],
			}),
		),
	);
});

test('Excalidraw round trip preserves text, bindings and Unicode completion counters', async () => {
	const { serializePlannerDrawing, parsePlannerDrawing, drawingPlan } = await import(
		'../src/planner-excalidraw'
	);
	const { canvasProgress } = await import('../src/planner-canvas');
	const scene = {
		type: 'excalidraw',
		elements: [
			{ id: 'box', type: 'rectangle', x: 40, y: 60, width: 700, height: 500 },
			{
				id: 'text',
				type: 'text',
				x: 60,
				y: 80,
				width: 660,
				height: 300,
				originalText: 'This week · 2026-W43\n☑ Deploy demo\n☐ Finish login',
				text: 'wrapped visual text',
				containerId: 'box',
				fontSize: 48,
			},
			{ id: 'goal', type: 'rectangle', x: 900, y: 60, width: 700, height: 500 },
			{
				id: 'arrow',
				type: 'arrow',
				x: 740,
				y: 100,
				width: 160,
				height: 0,
				startBinding: { elementId: 'box' },
				endBinding: { elementId: 'goal' },
			},
		],
		appState: { theme: 'light' },
		files: {},
	};
	const raw = serializePlannerDrawing('', scene);
	const read = parsePlannerDrawing(raw);
	assert.equal(read.elements[1]?.fontSize, 48);
	assert.match(raw, /☑ Deploy demo/);
	const board = drawingPlan(read);
	assert.equal(board.edges[0]?.fromNode, 'box');
	assert.equal(board.edges[0]?.toNode, 'goal');
	assert.deepEqual(canvasProgress(board, 'This week · 2026-W43'), { done: 1, total: 2 });
});

test('closed Excalidraw updates preserve geometry, original notes and bindings and reject text conflicts', async () => {
	const { TFile } = await import('obsidian');
	const { serializePlannerDrawing, parsePlannerDrawing, drawingPlan, updatePlannerDrawing } =
		await import('../src/planner-excalidraw');
	const scene = {
		type: 'excalidraw',
		elements: [
			{
				id: 'box',
				type: 'rectangle',
				x: 40,
				y: 60,
				width: 700,
				height: 500,
				strokeColor: '#2563eb',
			},
			{
				id: 'text',
				type: 'text',
				x: 60,
				y: 80,
				width: 660,
				height: 300,
				originalText: 'Interview plan\n☐ Practice ML',
				text: 'Interview plan\n☐ Practice ML',
				containerId: 'box',
				fontSize: 48,
				fontFamily: 2,
			},
		],
		appState: { zoom: { value: 1 } },
		files: {},
	};
	let raw = serializePlannerDrawing('', scene).replace(
		'# Excalidraw Data',
		'My extra note.\n\n# Excalidraw Data',
	);
	const file = new TFile();
	file.path = 'Plans/Planner Board.excalidraw.md';
	const app = {
		vault: {
			read: async () => raw,
			process: async (_file: unknown, fn: (value: string) => string) => {
				raw = fn(raw);
			},
		},
	};
	const original = drawingPlan(parsePlannerDrawing(raw));
	const proposed = JSON.parse(JSON.stringify(original));
	proposed.nodes[1].text = 'Interview plan\n☑ Practice ML';
	assert.equal(await updatePlannerDrawing(app as never, file as never, original, proposed), true);
	const updated = parsePlannerDrawing(raw);
	assert.equal(updated.elements[0]?.x, 40);
	assert.equal(updated.elements[0]?.strokeColor, '#2563eb');
	assert.equal(updated.elements[1]?.fontSize, 48);
	assert.equal(updated.elements[1]?.containerId, 'box');
	assert.match(raw, /My extra note/);
	assert.equal(drawingPlan(updated).nodes[1]?.text, 'Interview plan\n☑ Practice ML');
	await assert.rejects(
		updatePlannerDrawing(app as never, file as never, original, proposed),
		/card changed/,
	);
});

test('compressed Excalidraw data uses the installed plugin decoder and ignores other JSON fences', async () => {
	const { parsePlannerDrawing } = await import('../src/planner-excalidraw');
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	let encoded = '';
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			ExcalidrawAutomate: {
				decompressFromBase64: (value: string) => {
					encoded = value;
					return '{"type":"excalidraw","elements":[]}';
				},
			},
		},
	});
	try {
		const raw =
			'# User notes\n```json\n{"not":"a drawing"}\n```\n\n## Drawing\n```compressed-json\nabc\n\n123\n```\n%%';
		assert.equal(parsePlannerDrawing(raw).type, 'excalidraw');
		assert.equal(encoded, 'abc123');
	} finally {
		if (previous) Object.defineProperty(globalThis, 'window', previous);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('open Excalidraw saves through its native editor API and preserves in-memory movement', async () => {
	const { TFile } = await import('obsidian');
	const { serializePlannerDrawing, parsePlannerDrawing, drawingPlan, updatePlannerDrawing } =
		await import('../src/planner-excalidraw');
	const original = {
		type: 'excalidraw',
		elements: [
			{ id: 'box', type: 'rectangle', x: 40, y: 60, width: 700, height: 500 },
			{
				id: 'text',
				type: 'text',
				x: 60,
				y: 80,
				width: 660,
				height: 300,
				originalText: 'Interview plan\n☐ Practice',
				text: 'Interview plan\n☐ Practice',
				containerId: 'box',
				fontSize: 48,
			},
		],
	};
	let raw = serializePlannerDrawing('', original);
	let live = JSON.parse(JSON.stringify(original.elements));
	live[0].x = 900;
	let saves = 0;
	const file = new TFile();
	file.path = 'Plans/Planner Board.excalidraw.md';
	const view = {
		file,
		excalidrawAPI: { getSceneElements: () => live },
		updateScene: (value: { elements: unknown }) => {
			live = value.elements;
		},
		forceSave: async (silent: boolean, wait: boolean) => {
			assert(silent && wait);
			saves++;
			raw = serializePlannerDrawing('', { type: 'excalidraw', elements: live });
		},
	};
	const app = {
		vault: {
			read: async () => raw,
			process: () => {
				throw new Error('Open drawing must use native editor');
			},
		},
		workspace: { iterateAllLeaves: (fn: (leaf: unknown) => void) => fn({ view }) },
	};
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { requestAnimationFrame: (fn: () => void) => fn() },
	});
	try {
		const snapshot = drawingPlan(original),
			proposed = drawingPlan(original);
		proposed.nodes[1].text = 'Interview plan\n☑ Practice';
		assert(await updatePlannerDrawing(app as never, file as never, snapshot, proposed));
		assert.equal(saves, 1);
		const saved = parsePlannerDrawing(raw);
		assert.equal(saved.elements[0]?.x, 900);
		assert.equal(drawingPlan(saved).nodes[1]?.text, 'Interview plan\n☑ Practice');
	} finally {
		if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('calendar range filtering includes overlapping events without parsing unrelated cached dates', async () => {
	const { inCalendarRange } = await import('../src/calendar-range');
	const from = new Date('2026-10-19T00:00:00'),
		to = new Date('2026-10-26T00:00:00');
	assert(inCalendarRange('2026-10-20T09:00:00', '2026-10-20T10:00:00', false, from, to));
	assert(inCalendarRange('2026-10-18T23:30:00', '2026-10-19T01:00:00', false, from, to));
	assert(inCalendarRange('2026-10-18', '2026-10-21', true, from, to));
	assert(!inCalendarRange('2026-10-18', '2026-10-19', true, from, to));
	assert(!inCalendarRange('2026-10-26', '2026-10-27', true, from, to));
	assert(!inCalendarRange('invalid', '', false, from, to));
	assert(inCalendarRange('2026-10-23', '', true, from, to));
});

test('event color menu choices preserve custom labels, expose gray and clear the correct color API', async () => {
	const { eventColorChoices } = await import('../src/event-colors');
	let choices = eventColorChoices({ colorId: '8' }, [], '#0b8043');
	assert(
		choices.find((item) => 'colorId' in item.changes && item.changes.colorId === '8')?.selected,
	);
	assert.deepEqual(choices[0]?.changes, { colorId: '' });
	choices = eventColorChoices({ colorId: '', eventLabelId: 'custom' }, [
		{ id: 'custom', name: 'Research', backgroundColor: '#123456' },
	]);
	assert(choices.find((item) => item.name === 'Research')?.selected);
	assert.deepEqual(choices.find((item) => item.name === 'Research')?.changes, {
		eventLabelId: 'custom',
	});
	assert.deepEqual(choices[0]?.changes, { eventLabelId: '' });
	assert(
		choices.some((item) => 'colorId' in item.changes && item.changes.colorId === '8'),
		'gray remains available if custom labels omit it',
	);
});

test('continuous day range crosses DST and year boundaries without changing column counts', async () => {
	const { scrollingRange, dayDifference, addCalendarDays } = await import(
		'../src/calendar-scroll'
	);
	for (const anchor of [new Date(2026, 10, 1), new Date(2026, 2, 8), new Date(2026, 0, 1)]) {
		const range = scrollingRange(anchor);
		assert.equal(dayDifference(range.start, range.end), 49);
		assert.equal(dayDifference(range.start, anchor), 21);
		assert.equal(dayDifference(anchor, addCalendarDays(anchor, 7)), 7);
	}
});

test('native scrolling moves fractional days, rebases at buffer edges and leaves wheel/touch native', async () => {
	const { registerCalendarScroll, scrollingRange, addCalendarDays } = await import(
		'../src/calendar-scroll'
	);
	const listeners = new Map<string, (event: any) => void>();
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	const view = {
		setTimeout: (fn: () => void) => {
			timers.set(++nextTimer, fn);
			return nextTimer;
		},
		clearTimeout: (id: number) => timers.delete(id),
		requestAnimationFrame: (_fn: () => void) => 1,
		cancelAnimationFrame: () => {},
	};
	const doc = { defaultView: view };
	const root = { ownerDocument: doc, classList: { add() {}, remove() {} } };
	const viewport = {
		clientWidth: 1312,
		scrollLeft: 0,
		scrollTop: 120,
		classList: { toggle() {} },
		scrollTo: ({ left }: { left: number }) => {
			viewport.scrollLeft = left;
		},
	};
	const content = { setCssProps: (_props: unknown) => {} };
	const cleanup: (() => void)[] = [];
	const owner = {
		register: (fn: () => void) => cleanup.push(fn),
		registerDomEvent: (_target: unknown, name: string, fn: (event: any) => void) =>
			listeners.set(name, fn),
	};
	let navigations = 0;
	const anchor = new Date(2026, 9, 23);
	const calendar = {
		gotoDate: (date: Date) => {
			navigations++;
			const range = scrollingRange(date);
			scroller.dates(true, range.start, range.end, date);
		},
	};
	const scroller = registerCalendarScroll(
		owner as never,
		root as never,
		() => calendar as never,
		() => {},
	);
	scroller.prepare(viewport as never, content as never, true);
	const range = scrollingRange(anchor);
	scroller.dates(true, range.start, range.end, anchor);
	assert.equal(viewport.scrollLeft, 21 * 180);
	assert(!listeners.has('wheel'));
	assert(!listeners.has('touchmove'));
	viewport.scrollLeft += 35;
	listeners.get('scroll')?.({ target: viewport });
	for (const fn of [...timers.values()]) fn();
	assert.equal(navigations, 0, 'ordinary scrolling never pages or rerenders');
	assert.equal(viewport.scrollLeft, 21 * 180 + 35);
	scroller.step(7);
	assert.equal(viewport.scrollLeft, 28 * 180 + 35);
	viewport.scrollLeft = 3 * 180 + 47;
	listeners.get('scroll')?.({ target: viewport });
	for (const fn of [...timers.values()]) fn();
	assert.equal(navigations, 1);
	assert.equal(
		Math.round(viewport.scrollLeft),
		21 * 180 + 47,
		'edge rebase preserves the fractional visible day',
	);
	const eventTarget = {
		closest: (selector: string) => (selector === '.gcal-calendar-viewport' ? viewport : {}),
	};
	listeners.get('mousedown')?.({ button: 0, target: eventTarget });
	listeners.get('mousemove')?.({ buttons: 1, clientX: 20, clientY: 0 });
	assert.equal(
		Math.round(viewport.scrollLeft),
		21 * 180 + 47,
		'event dragging is left to FullCalendar',
	);
	const emptyTarget = {
		closest: (selector: string) => (selector === '.gcal-calendar-viewport' ? viewport : null),
	};
	listeners.get('mousedown')?.({ button: 0, target: emptyTarget, clientX: 100, clientY: 100 });
	let prevented = false;
	listeners.get('mousemove')?.({
		buttons: 1,
		clientX: 80,
		clientY: 100,
		preventDefault: () => {
			prevented = true;
		},
	});
	assert.equal(
		Math.round(viewport.scrollLeft),
		21 * 180 + 67,
		'empty-space mouse pan tracks each pixel',
	);
	assert(prevented);
	assert(scroller.suppressSelection());
	assert.equal(viewport.scrollTop, 120);
	const positionBeforeResize = viewport.scrollLeft / 180;
	viewport.clientWidth = 752;
	scroller.resize();
	assert(
		Math.abs(viewport.scrollLeft / 100 - positionBeforeResize) < 0.000001,
		'resizing fits seven days into the pane and preserves the visible date',
	);
	scroller.dates(false, anchor, addCalendarDays(anchor, 1), anchor);
	assert(!scroller.step(7), 'other views use their normal date navigation');
	for (const fn of cleanup) fn();
});

test('color picker renders swatches with accessible names and closes after choosing or dismissing', async () => {
	const { showEventColorPalette, swatchTextColor } = await import('../src/event-color-palette');
	const { eventColorChoices } = await import('../src/event-colors');
	const listeners = new Map<string, (event: any) => void>();
	const all: FakeElement[] = [];
	class FakeElement {
		children: FakeElement[] = [];
		attrs: Record<string, string>;
		text: string;
		cls: string;
		removed = false;
		props: Record<string, string> = {};
		onclick?: () => void;
		constructor(options: any = {}) {
			this.attrs = options.attr ?? {};
			this.text = options.text ?? '';
			this.cls = options.cls ?? '';
			all.push(this);
		}
		createDiv(options: any) {
			const el = new FakeElement(options);
			this.children.push(el);
			return el;
		}
		createEl(_tag: string, options: any) {
			return this.createDiv(options);
		}
		createSpan(options: any) {
			return this.createDiv(options);
		}
		setCssProps(props: Record<string, string>) {
			Object.assign(this.props, props);
		}
		getAttribute(name: string) {
			return this.attrs[name];
		}
		focus() {
			doc.activeElement = this;
		}
		getBoundingClientRect() {
			return { width: 220, height: 240 };
		}
		contains(target: FakeElement): boolean {
			return target === this || this.children.some((child) => child.contains(target));
		}
		remove() {
			this.removed = true;
		}
	}
	const doc = {
		body: new FakeElement(),
		activeElement: null as FakeElement | null,
		defaultView: {
			innerWidth: 900,
			innerHeight: 600,
			addEventListener() {},
			removeEventListener() {},
		},
		addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
		removeEventListener: (name: string) => listeners.delete(name),
	};
	const choices = eventColorChoices({ colorId: '8' }, [], '#0b8043');
	let selected: unknown;
	showEventColorPalette(doc as never, 890, 590, choices, (choice) => {
		selected = choice.changes;
	});
	const popover = all.find((el) => el.cls === 'gcal-color-popover')!;
	const swatches = all.filter((el) => el.cls === 'gcal-color-choice');
	assert.equal(swatches.length, choices.length - 1);
	assert(
		swatches.every((el) => el.text === '' || el.text === '✓'),
		'hex labels are not visible menu rows',
	);
	assert(swatches.every((el) => !!el.attrs['aria-label'] && !!el.props['--gcal-swatch']));
	assert.equal(popover.props.left, '672px');
	assert.equal(popover.props.top, '352px');
	assert.equal(doc.activeElement?.text, '✓');
	swatches[0]?.onclick?.();
	assert.deepEqual(selected, choices[1]?.changes);
	assert(popover.removed);
	assert.equal(listeners.size, 0);
	const second = showEventColorPalette(doc as never, 1, 1, choices, () => {});
	listeners.get('keydown')?.({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
	assert.equal(listeners.size, 0);
	second.close();
	showEventColorPalette(doc as never, 1, 1, choices, () => {});
	listeners.get('pointerdown')?.({ target: doc.body });
	assert.equal(listeners.size, 0);
	assert.equal(swatchTextColor('#ffffff'), '#111111');
	assert.equal(swatchTextColor('#333333'), '#ffffff');
	let copied = 0;
	showEventColorPalette(doc as never, 1, 1, choices, () => {}, false, [
		{
			name: 'Copy',
			shortcut: '⌘C',
			run: () => {
				copied++;
			},
		},
	]);
	const menu = all.find((el) => el.cls === 'gcal-event-context-actions');
	assert(menu);
	assert.equal(menu.children[0]?.children[0]?.text, 'Copy');
	menu.children[0]?.onclick?.();
	assert.equal(copied, 1);
	assert.equal(listeners.size, 0);
	showEventColorPalette(doc as never, 1, 1, choices, () => {}, false, [
		{
			name: 'Copy',
			shortcut: '⌘C',
			run: () => {
				copied++;
			},
		},
	]);
	listeners.get('keydown')?.({
		key: 'c',
		metaKey: true,
		preventDefault() {},
		stopPropagation() {},
	});
	assert.equal(copied, 2, 'menu shortcuts invoke the same event actions');
	assert.equal(listeners.size, 0);
});

test('palette color saves use the latest etag and restore the display if Google rejects the edit', async () => {
	const { GCalBlock } = await import('../src/view');
	const { eventColorChoices } = await import('../src/event-colors');
	const selected = eventColorChoices({ colorId: '2' })[1];
	assert(selected);
	const writes: unknown[][] = [];
	let fail = false,
		notifications = 0;
	const block = {
		pendingColors: new Set<string>(),
		plugin: {
			cache: {
				calendar: () => ({ events: { e: { calendarId: 'c', id: 'e', etag: 'fresh' } } }),
			},
			calendars: {
				patch: async (...args: unknown[]) => {
					writes.push(args);
					if (fail) throw new Error('Rejected');
				},
			},
			notifyChanged: () => {
				notifications++;
			},
		},
	};
	const event = {
		id: 'c/e',
		backgroundColor: '#111111',
		borderColor: '#111111',
		extendedProps: { kind: 'event', ev: { id: 'e', calendarId: 'c', etag: 'old' } },
		setProp(name: string, value: string) {
			if (name === 'backgroundColor') this.backgroundColor = value;
			if (name === 'borderColor') this.borderColor = value;
		},
	};
	const change = (
		GCalBlock.prototype as unknown as {
			changeEventColor: (event: unknown, choice: unknown) => Promise<void>;
		}
	).changeEventColor;
	const saving = change.call(block, event, selected);
	assert.equal(
		event.backgroundColor,
		selected.color,
		'color changes before the network response',
	);
	await saving;
	assert.deepEqual(writes[0], ['c', 'e', 'fresh', selected.changes]);
	fail = true;
	const next = eventColorChoices({ colorId: '2' })[2];
	assert(next);
	await change.call(block, event, next);
	assert.equal(event.backgroundColor, selected.color);
	assert.equal(event.borderColor, selected.color);
	assert.equal(block.pendingColors.size, 0);
	assert.equal(notifications, 2);
});

test('duplicating an event inserts an independent copy with notes, location, calendar and original color', async () => {
	const { EventModal } = await import('../src/modal');
	const source = {
		id: 'source',
		calendarId: 'c',
		title: 'Build app portfolio',
		start: '2026-10-23T12:00:00-05:00',
		end: '2026-10-23T13:30:00-05:00',
		allDay: false,
		description: 'Goal\n• Export app\n• Add features',
		location: 'Office',
		colorId: '8',
		eventLabelId: '',
		recurringEventId: 'series',
		etag: 'original-etag',
	};
	const original = JSON.stringify(source);
	const inserts: Array<{ calendar: string; input: unknown }> = [];
	let patches = 0,
		notifications = 0,
		closes = 0;
	const plugin = {
		app: {},
		settings: { calendars: { c: { name: 'My calendar', enabled: true, color: '#123456' } } },
		cache: { calendar: () => ({ labels: [{ id: 'label', backgroundColor: '#123456' }] }) },
		calendars: {
			insert: async (calendar: string, input: unknown) => {
				inserts.push({ calendar, input });
			},
			patch: async () => {
				patches++;
			},
		},
		notifyChanged: () => {
			notifications++;
		},
	};
	type Editor = {
		input: () => Record<string, unknown>;
		save: () => Promise<void>;
		startDate: string;
		endDate: string;
	};
	const modal = new EventModal(plugin as never, { copyFrom: source });
	Object.assign(modal, {
		close: () => {
			closes++;
		},
	});
	const editor = modal as unknown as Editor;
	const input = editor.input();
	assert.equal(input.title, source.title);
	assert.equal(input.description, source.description);
	assert.equal(input.location, source.location);
	assert.equal(
		input.colorId,
		'8',
		'legacy colors survive even when the calendar has custom labels',
	);
	for (const field of ['id', 'etag', 'calendarId', 'recurringEventId']) assert(!(field in input));
	editor.startDate = '2026-10-24';
	editor.endDate = '2026-10-24';
	await editor.save();
	assert.equal(inserts.length, 1);
	assert.equal(inserts[0]?.calendar, 'c');
	assert.equal(patches, 0);
	assert.equal(notifications, 1);
	assert.equal(closes, 1);
	assert.equal(JSON.stringify(source), original, 'the original occurrence stays untouched');
	const labeled = new EventModal(plugin as never, {
		copyFrom: { ...source, eventLabelId: 'label' },
	}) as unknown as Editor;
	assert.equal(labeled.input().eventLabelId, 'label');
	assert(!('colorId' in labeled.input()));
	const allDay = new EventModal(plugin as never, {
		copyFrom: { ...source, start: '2026-10-23', end: '2026-10-26', allDay: true },
	}) as unknown as Editor;
	assert.equal(allDay.input().start, '2026-10-23');
	assert.equal(
		allDay.input().end,
		'2026-10-26',
		'multi-day all-day exclusive end survives copying',
	);
});

test('event clicks open the details panel and task clicks still open their note', async () => {
	const { GCalBlock } = await import('../src/view');
	let selected: unknown,
		prevented = 0,
		closed = 0;
	const opened: string[] = [];
	const block = {
		detailsPanel: {
			show: (event: unknown) => {
				selected = event;
			},
		},
		colorPopover: {
			close: () => {
				closed++;
			},
		},
		plugin: {
			app: {
				workspace: {
					openLinkText: async (path: string) => {
						opened.push(path);
					},
				},
			},
		},
	};
	const click = (GCalBlock.prototype as unknown as { onEventClick: (info: unknown) => void })
		.onEventClick;
	const event = { id: 'e' };
	click.call(block, {
		event: { extendedProps: { kind: 'event', ev: event } },
		jsEvent: {
			preventDefault: () => {
				prevented++;
			},
		},
	});
	assert.equal(selected, event);
	assert.equal(prevented, 1);
	assert.equal(closed, 1);
	click.call(block, { event: { extendedProps: { kind: 'task', path: 'Tasks/Prepare.md' } } });
	assert.deepEqual(opened, ['Tasks/Prepare.md']);
});

test('event detail times show duration and use inclusive display dates for all-day events', async () => {
	const { eventTimeSummary } = await import('../src/event-details');
	const event = { start: '2026-10-23T12:00:00', end: '2026-10-23T13:30:00', allDay: false };
	assert.match(eventTimeSummary(event as never), /1h 30m/);
	const day = eventTimeSummary({
		...event,
		start: '2026-10-23',
		end: '2026-10-24',
		allDay: true,
	} as never);
	assert.match(day, /All day/);
	assert(!day.includes(' – '), 'a one-day event does not show its exclusive end date');
	const multiple = eventTimeSummary({
		...event,
		start: '2026-10-23',
		end: '2026-10-26',
		allDay: true,
	} as never);
	assert(multiple.includes(' – '));
	assert(multiple.includes('25'));
});

test('inline event edits save only changed fields and reject conflicts while preserving guest metadata', async () => {
	const { eventDraft, eventDraftPatch, splitEventDescription } = await import(
		'../src/event-editing'
	);
	const base = fromGoogle('c', {
		id: 'e',
		summary: 'Portfolio',
		etag: 'old',
		start: { dateTime: '2026-10-23T12:00:00' },
		end: { dateTime: '2026-10-23T13:30:00' },
		description: '<b>Goals</b>',
		attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
	});
	const draft = eventDraft(base);
	assert.deepEqual(eventDraftPatch(base, draft, base), {});
	draft.title = 'New title';
	assert.deepEqual(eventDraftPatch(base, draft, { ...base, location: 'Changed elsewhere' }), {
		title: 'New title',
	});
	assert.throws(
		() => eventDraftPatch(base, draft, { ...base, title: 'Concurrent title' }),
		/changed elsewhere/,
	);
	draft.participants = 'a@example.com\nb@example.com';
	assert.deepEqual(eventDraftPatch(base, draft, base).attendees, [
		{ email: 'a@example.com', responseStatus: 'accepted' },
		{ email: 'b@example.com' },
	]);
	draft.participants = 'invalid email';
	assert.throws(() => eventDraftPatch(base, draft, base), /valid email/);
	draft.participants = eventDraft(base).participants;
	draft.links = 'https://example.com/project';
	const description = eventDraftPatch(base, draft, base).description;
	assert(description);
	assert.deepEqual(splitEventDescription(description), {
		notes: '<b>Goals</b>',
		links: 'https://example.com/project',
	});
	draft.links = 'javascript:alert(1)';
	assert.throws(() => eventDraftPatch(base, draft, base), /https/);
	const timed = eventDraft(base);
	timed.endTime = '11:00';
	assert.throws(() => eventDraftPatch(base, timed, base), /end must be after/);
	timed.endTime = '14:00';
	const timePatch = eventDraftPatch(base, timed, base);
	assert.equal(timePatch.allDay, false);
	assert.equal(parseDateForTest(timePatch.end).getHours(), 14);
	assert(!('description' in timePatch));
	const allDay = { ...base, allDay: true, start: '2026-10-23', end: '2026-10-25' };
	const allDayDraft = eventDraft(allDay);
	allDayDraft.endDate = '2026-10-26';
	assert.equal(eventDraftPatch(allDay, allDayDraft, allDay).end, '2026-10-27');
	function parseDateForTest(value: string | undefined) {
		assert(value);
		return new Date(value);
	}
});

test('calendar copy shortcuts place independent events and leave text editors native; cut moves only on paste', async () => {
	const { CalendarEventActions, pastedEventInput } = await import('../src/event-actions');
	const source = fromGoogle('c', {
		id: 'e',
		summary: 'Work',
		etag: 'fresh',
		start: { dateTime: '2026-10-23T12:00:00' },
		end: { dateTime: '2026-10-23T13:30:00' },
		description: 'Notes',
		colorId: '8',
	});
	let keyboard: (event: unknown) => void = () => {};
	let inEditor = false,
		prevented = 0;
	const doc = {
		activeElement: { closest: () => (inEditor ? {} : null) },
		getSelection: () => null,
	};
	const root = { ownerDocument: doc, contains: () => true, focus() {}, tabIndex: 0 };
	const owner = {
		registerDomEvent: (_target: unknown, _type: string, handler: (event: unknown) => void) => {
			if (_type === 'keydown') keyboard = handler;
		},
	};
	const inserts: unknown[] = [],
		patches: unknown[][] = [];
	let fail = false;
	const plugin = {
		cache: { calendar: () => ({ events: { e: source } }) },
		calendars: {
			insert: async (_calendar: string, input: unknown) => {
				if (fail) throw new Error('Offline');
				inserts.push(input);
				return { ...source, id: 'copy' };
			},
			patch: async (...args: unknown[]) => {
				patches.push(args);
				return source;
			},
		},
		notifyChanged() {},
	};
	const actions = new CalendarEventActions(plugin as never, owner as never, root as never);
	const press = (key: string) =>
		keyboard({
			key,
			metaKey: true,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation() {},
		});
	actions.select(source);
	inEditor = true;
	press('c');
	assert.equal(prevented, 0);
	inEditor = false;
	press('c');
	assert.equal(prevented, 1);
	assert(actions.place({ start: '2026-10-25T09:00:00', allDay: false }));
	fail = true;
	await actions.paste();
	assert.equal(inserts.length, 0);
	fail = false;
	await actions.paste();
	assert.equal(inserts.length, 1);
	const pasted = inserts[0] as Record<string, unknown>;
	assert.equal(pasted.description, 'Notes');
	assert.equal(pasted.colorId, '8');
	assert(!('id' in pasted));
	assert.equal(
		new Date(pasted.end as string).getTime() - new Date(pasted.start as string).getTime(),
		90 * 60000,
	);
	assert(
		!actions.place({ start: '2026-10-26T09:00:00', allDay: false }),
		'after pasting, empty-space selection returns to creating events',
	);
	actions.select(source);
	press('x');
	assert.equal(patches.length, 0);
	actions.place({ start: '2026-10-27T09:00:00', allDay: false });
	await actions.paste();
	assert.equal(patches.length, 1);
	assert.deepEqual(patches[0]?.slice(0, 3), ['c', 'e', 'fresh']);
	assert.deepEqual(Object.keys(patches[0]?.[3] as object).sort(), ['allDay', 'end', 'start']);
	const allDay = pastedEventInput(
		{ ...source, allDay: true, start: '2026-10-31', end: '2026-11-03' },
		{ start: '2026-11-07', allDay: true },
	);
	assert.equal(allDay.start, '2026-11-07');
	assert.equal(allDay.end, '2026-11-10');
});

test('inline panel saves against the latest etag and retains failed drafts across sync refreshes', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	const { eventDraft } = await import('../src/event-editing');
	const base = fromGoogle('c', {
		id: 'e',
		etag: 'old',
		summary: 'Before',
		start: { date: '2026-10-23' },
		end: { date: '2026-10-24' },
	});
	let latest = { ...base, etag: 'fresh', location: 'Updated elsewhere' };
	let fail = true,
		notifications = 0,
		renders = 0;
	const writes: unknown[][] = [];
	const state = { base, draft: { ...eventDraft(base), title: 'My title' }, dirty: true };
	const drafts = new Map([['c/e', state]]);
	let status = '';
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		selected: base,
		drafts,
		saving: new Set(),
		status: {
			setText: (value: string) => {
				status = value;
			},
		},
		render: () => {
			renders++;
		},
		plugin: {
			cache: { calendar: () => ({ events: { e: latest } }) },
			calendars: {
				patch: async (...args: unknown[]) => {
					writes.push(args);
					if (fail) throw new Error('Offline');
					latest = { ...latest, title: 'My title' };
					return latest;
				},
			},
			notifyChanged: () => {
				notifications++;
			},
		},
	}) as { save: (event: unknown, state: unknown) => Promise<void>; refresh: () => void };
	panel.refresh();
	assert.equal(renders, 0, 'background sync does not replace a draft in progress');
	await panel.save(base, state);
	assert.equal(writes[0]?.[2], 'fresh');
	assert.deepEqual(writes[0]?.[3], { title: 'My title' });
	assert.equal(drafts.get('c/e'), state);
	assert.equal(status, 'Not saved: Offline');
	assert.equal(notifications, 0);
	fail = false;
	await panel.save(base, state);
	assert.equal(drafts.get('c/e')?.dirty, false);
	assert.equal(status, 'Saved');
	assert.equal(notifications, 1);
	assert.equal(latest.location, 'Updated elsewhere');
});

test('guest fields round-trip through Google and attendee patches request no invitation notifications', async () => {
	const guests = [{ email: 'a@example.com', responseStatus: 'accepted' }];
	const event = fromGoogle('c', { id: 'e', attendees: guests });
	assert.deepEqual(event.attendees, guests);
	assert.deepEqual(toGoogle({ attendees: [] }, true), { attendees: [] });
	const cache = memoryCache();
	cache.saveCalendar('c', { syncToken: 's', syncedAt: 1, events: { e: event } });
	const calls: unknown[] = [];
	const g = {
		call: async (_method: string, _url: string, options: unknown) => {
			calls.push(options);
			return { id: 'e', attendees: guests };
		},
	};
	const calendars = new CalendarSync(g as never, cache);
	await calendars.patch('c', 'e', 'fresh', { attendees: guests });
	const call = calls[0] as {
		query: Record<string, unknown>;
		body: unknown;
		headers: Record<string, unknown>;
	};
	assert.equal(call.query.sendUpdates, 'none');
	assert.equal(call.headers['If-Match'], 'fresh');
	assert.deepEqual(call.body, { attendees: guests });
});

test('time dropdowns label all quarter-hours in AM/PM and preserve existing off-quarter times', async () => {
	const { timeChoices, timeLabel } = await import('../src/event-times');
	const choices = timeChoices('11:45');
	assert.equal(choices.length, 96);
	assert.deepEqual(choices.slice(44, 49), [
		{ value: '11:00', label: '11 AM' },
		{ value: '11:15', label: '11:15 AM' },
		{ value: '11:30', label: '11:30 AM' },
		{ value: '11:45', label: '11:45 AM' },
		{ value: '12:00', label: '12 PM' },
	]);
	assert.equal(timeLabel('00:00'), '12 AM');
	assert.equal(timeLabel('13:00'), '1 PM');
	const custom = timeChoices('09:10');
	assert.equal(custom.length, 97);
	assert.deepEqual(custom[37], { value: '09:10', label: '9:10 AM' });
});

test('autosave queues edits typed during a request without rendering or losing the newer draft', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	const { eventDraft } = await import('../src/event-editing');
	const base = fromGoogle('c', {
		id: 'e',
		etag: 'v1',
		summary: 'Before',
		start: { date: '2026-10-23' },
		end: { date: '2026-10-24' },
	});
	let latest = base;
	const state = { base, draft: { ...eventDraft(base), title: 'First edit' }, dirty: true };
	const writes: unknown[][] = [],
		queued: unknown[][] = [];
	let resolveRequest: (value: unknown) => void = () => {};
	let renders = 0;
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		selected: base,
		drafts: new Map([['c/e', state]]),
		saving: new Set(),
		status: { setText() {} },
		render: () => {
			renders++;
		},
		schedule: (...args: unknown[]) => {
			queued.push(args);
		},
		plugin: {
			cache: { calendar: () => ({ events: { e: latest } }) },
			calendars: {
				patch: (...args: unknown[]) => {
					writes.push(args);
					return new Promise((resolve) => {
						resolveRequest = resolve;
					});
				},
			},
			notifyChanged() {},
		},
	}) as { save: (event: unknown, state: unknown) => Promise<void> };
	const first = panel.save(base, state);
	assert.equal(writes.length, 1);
	state.draft.title = 'Newer edit while saving';
	await panel.save(base, state);
	assert.equal(writes.length, 1, 'requests for one event are serialized');
	latest = { ...base, title: 'First edit', etag: 'v2' };
	resolveRequest(latest);
	await first;
	assert.equal(state.draft.title, 'Newer edit while saving');
	assert.equal(state.base.etag, 'v2');
	assert.equal(state.dirty, true);
	assert.equal(queued.length, 1);
	assert.equal(renders, 0, 'autosave never replaces the active editor DOM');
	const second = panel.save(state.base, state);
	assert.equal(writes[1]?.[2], 'v2');
	assert.deepEqual(writes[1]?.[3], { title: 'Newer edit while saving' });
	latest = { ...latest, title: 'Newer edit while saving', etag: 'v3' };
	resolveRequest(latest);
	await second;
	assert.equal(state.dirty, false);
	assert.equal(renders, 0);
});

test('autosave debounces typing and flushes pending edits on blur and panel unload', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	const base = fromGoogle('c', { id: 'e' }),
		state = { base, dirty: true };
	let id = 0;
	const tasks = new Map<number, () => void>(),
		delays: number[] = [],
		saves: unknown[] = [];
	const view = {
		setTimeout: (fn: () => void, delay: number) => {
			tasks.set(++id, fn);
			delays.push(delay);
			return id;
		},
		clearTimeout: (timer: number) => {
			tasks.delete(timer);
		},
	};
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		containerEl: { ownerDocument: { defaultView: view } },
		timers: new Map(),
		drafts: new Map([['c/e', state]]),
		disposed: false,
		save: async (_event: unknown, draft: unknown) => {
			saves.push(draft);
		},
	}) as {
		schedule: (key: string, state: unknown) => void;
		flush: (key: string, state: unknown) => void;
		onunload: () => void;
	};
	panel.schedule('c/e', state);
	panel.schedule('c/e', state);
	assert.equal(tasks.size, 1, 'new keystrokes replace the prior timer');
	assert.deepEqual(delays, [700, 700]);
	const callback = [...tasks.values()][0];
	assert(callback);
	tasks.clear();
	callback();
	assert.equal(saves.length, 1);
	panel.schedule('c/e', state);
	panel.flush('c/e', state);
	assert.equal(tasks.size, 0);
	assert.equal(saves.length, 2, 'blur flushes without waiting for the debounce');
	panel.schedule('c/e', state);
	panel.onunload();
	assert.equal(tasks.size, 0);
	assert.equal(saves.length, 3, 'closing the calendar flushes pending drafts');
});

test('compact single-date editing preserves spans and time picks handle overnight events', async () => {
	const { eventDraft, moveDraftDate, setDraftTime, eventDraftPatch } = await import(
		'../src/event-editing'
	);
	const event = fromGoogle('c', {
		id: 'e',
		start: { dateTime: '2026-10-23T12:45:00' },
		end: { dateTime: '2026-10-23T14:15:00' },
	});
	const draft = eventDraft(event);
	assert(moveDraftDate(draft, '2026-10-25'));
	assert.equal(draft.endDate, '2026-10-25');
	setDraftTime(draft, 'endTime', '01:00');
	assert.equal(draft.endDate, '2026-10-26');
	assert.equal(new Date(eventDraftPatch(event, draft, event).end ?? '').getDate(), 26);
	setDraftTime(draft, 'endTime', '15:00');
	assert.equal(draft.endDate, '2026-10-25');
	const allDay = eventDraft({ ...event, allDay: true, start: '2026-10-31', end: '2026-11-03' });
	assert(moveDraftDate(allDay, '2026-11-07'));
	assert.equal(
		allDay.endDate,
		'2026-11-09',
		'inclusive multi-day end moves with the sole date field',
	);
	const before = JSON.stringify(allDay);
	assert(!moveDraftDate(allDay, ''));
	assert(!moveDraftDate(allDay, '2026-02-30'));
	assert.equal(JSON.stringify(allDay), before);
	const longer = eventDraft({ ...event, end: '2026-10-24T14:15:00' });
	setDraftTime(longer, 'endTime', '16:00');
	assert.equal(
		longer.endDate,
		'2026-10-24',
		'an existing event longer than a day keeps its span',
	);
});

test('Live Preview parent editors do not swallow calendar copy/paste or Delete, while local inputs remain native', async () => {
	const { CalendarEventActions } = await import('../src/event-actions');
	const source = fromGoogle('c', {
		id: 'e',
		summary: 'Work',
		start: { dateTime: '2026-10-23T12:45:00' },
		end: { dateTime: '2026-10-23T14:15:00' },
		description: 'Notes',
	});
	const events: Record<string, typeof source> = { e: source };
	const handlers = new Map<string, (event: any) => void>();
	const keyTargets: unknown[] = [];
	let active: any,
		focusedEditor = false;
	const host = { contains: () => true, closest: () => host };
	const input = { closest: () => input };
	const view = {};
	const doc = {
		defaultView: view,
		get activeElement() {
			return active;
		},
		getSelection: () => null,
	};
	const root = {
		ownerDocument: doc,
		tabIndex: 0,
		contains: (node: unknown) => node === root || node === input,
		closest: () => host,
		focus: () => {
			active = focusedEditor ? host : root;
		},
	};
	active = root;
	const owner = {
		registerDomEvent: (target: unknown, name: string, handler: (event: any) => void) => {
			handlers.set(name, handler);
			if (name === 'keydown') keyTargets.push(target);
		},
	};
	let inserts = 0,
		prevented = 0;
	const removed: string[] = [],
		shown: string[] = [];
	const plugin = {
		cache: { calendar: () => ({ events }) },
		calendars: {
			insert: async (_calendar: string, input: Record<string, unknown>) => {
				const event = { ...source, ...input, id: `copy${++inserts}` };
				events[event.id] = event;
				return event;
			},
			remove: async (_calendar: string, id: string) => {
				removed.push(id);
				delete events[id];
			},
		},
		notifyChanged() {},
	};
	const actions = new CalendarEventActions(
		plugin as never,
		owner as never,
		root as never,
		(event) => {
			shown.push(event.id);
		},
	);
	assert.equal(
		keyTargets[0],
		view,
		'calendar keyboard capture precedes document editor shortcuts',
	);
	const press = (key: string, metaKey = false) =>
		handlers.get('keydown')?.({
			key,
			metaKey,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation() {},
		});
	actions.select(source);
	press('c', true);
	press('v', true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inserts, 1, 'Cmd+C/V work without an extra destination click');
	assert.deepEqual(shown, ['copy1']);
	assert.deepEqual(Object.keys(events).sort(), ['copy1', 'e']);
	press('Backspace');
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(removed, ['copy1']);
	assert(events.e);
	actions.select(source);
	active = input;
	const prior = prevented;
	press('Delete');
	press('c', true);
	assert.equal(
		prevented,
		prior,
		'typing and clipboard keys inside panel fields are not intercepted',
	);
	active = root;
	handlers.get('copy')?.({
		preventDefault() {},
		stopPropagation() {},
		clipboardData: { setData() {} },
	});
	handlers.get('paste')?.({ preventDefault() {}, stopPropagation() {} });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inserts, 2, 'native Electron clipboard events invoke the same actions');
	focusedEditor = true;
	actions.select(source);
	handlers.get('pointerdown')?.({ target: root });
	press('c', true);
	press('v', true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		inserts,
		3,
		'a Live Preview host regaining focus still permits calendar shortcuts',
	);
	actions.select(source);
	actions.duplicate();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inserts, 4, 'Duplicate creates a copy without opening an editor');
});

test('selecting a range creates an editable panel draft without inserting an empty event', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	let shown: any,
		focuses = 0;
	const draftKeys = new Set<string>();
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		plugin: {
			settings: { calendars: { primary: { enabled: true }, hidden: { enabled: false } } },
		},
		newEvents: draftKeys,
		containerEl: {
			querySelector: () => ({
				focus: () => {
					focuses++;
				},
			}),
		},
		show: (event: unknown) => {
			shown = event;
		},
	}) as { create: (range: { start: string; end: string; allDay: boolean }) => void };
	const range = {
		start: '2026-10-23T09:00:00-05:00',
		end: '2026-10-23T11:00:00-05:00',
		allDay: false,
	};
	panel.create(range);
	assert.equal(shown.calendarId, 'primary');
	assert.equal(shown.title, '');
	assert.equal(shown.start, range.start);
	assert.equal(shown.end, range.end);
	assert.match(shown.id, /^[0-9a-f]{32}$/);
	assert(draftKeys.has(`primary/${shown.id}`));
	assert.equal(focuses, 1, 'the new title is ready for typing immediately');
});

test('new-event panel autosave inserts once then patches edits typed during creation', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	const { eventDraft } = await import('../src/event-editing');
	const base = fromGoogle('c', {
		id: '12345678123456781234567812345678',
		summary: '',
		start: { dateTime: '2026-10-23T09:00:00' },
		end: { dateTime: '2026-10-23T11:00:00' },
	});
	base.title = '';
	const key = `c/${base.id}`,
		state = { base, draft: { ...eventDraft(base), notes: 'Some notes' }, dirty: true };
	const events: Record<string, typeof base> = {};
	const inserts: unknown[][] = [],
		patches: unknown[][] = [],
		created: unknown[] = [],
		queued: unknown[][] = [];
	let resolveInsert: (value: unknown) => void = () => {};
	let status = '';
	const newEvents = new Set([key]);
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		selected: base,
		drafts: new Map([[key, state]]),
		newEvents,
		saving: new Set(),
		status: {
			setText: (value: string) => {
				status = value;
			},
		},
		created: (event: unknown) => {
			created.push(event);
		},
		schedule: (...args: unknown[]) => {
			queued.push(args);
		},
		plugin: {
			cache: { calendar: () => ({ events }) },
			calendars: {
				insert: (...args: unknown[]) => {
					inserts.push(args);
					return new Promise((resolve) => {
						resolveInsert = resolve;
					});
				},
				patch: async (...args: unknown[]) => {
					patches.push(args);
					return (events[base.id] = {
						...events[base.id],
						description: 'Newer notes',
						etag: 'v2',
					} as typeof base);
				},
			},
			notifyChanged() {},
		},
	}) as { save: (event: unknown, state: unknown) => Promise<void> };
	await panel.save(base, state);
	assert.equal(inserts.length, 0, 'untitled range selections remain local drafts');
	assert.match(status, /Add a title/);
	state.draft.title = 'New event';
	const first = panel.save(base, state);
	assert.equal(inserts.length, 1);
	assert.equal(inserts[0]?.[2], base.id, 'the same stable Google event id is used for the draft');
	const inserted = inserts[0];
	assert(inserted);
	const input = inserted[1] as Record<string, unknown>;
	assert.equal(input.start, base.start);
	assert.equal(input.end, base.end);
	state.draft.notes = 'Newer notes';
	await panel.save(base, state);
	assert.equal(inserts.length, 1);
	events[base.id] = { ...base, title: 'New event', description: 'Some notes', etag: 'v1' };
	resolveInsert(events[base.id]);
	await first;
	assert.equal(created.length, 1);
	assert.equal(newEvents.size, 0);
	assert.equal(state.draft.notes, 'Newer notes');
	assert.equal(queued.length, 1);
	await panel.save(state.base, state);
	assert.equal(inserts.length, 1);
	assert.equal(patches.length, 1);
	assert.equal(patches[0]?.[2], 'v1');
	assert.deepEqual(patches[0]?.[3], { description: 'Newer notes' });
	assert.equal(state.dirty, false);
});

test('a copy finishing in the background does not replace the event selected for deletion', async () => {
	const { CalendarEventActions } = await import('../src/event-actions');
	const first = fromGoogle('c', { id: 'a' }),
		second = fromGoogle('c', { id: 'b' });
	let finishCopy: (event: unknown) => void = () => {};
	const removed: string[] = [],
		shown: unknown[] = [];
	const plugin = {
		cache: { calendar: () => ({ events: { a: first, b: second } }) },
		calendars: {
			insert: () =>
				new Promise((resolve) => {
					finishCopy = resolve;
				}),
			remove: async (_calendar: string, id: string) => {
				removed.push(id);
			},
		},
		notifyChanged() {},
	};
	const doc = {};
	const root = { ownerDocument: doc, focus() {} };
	const actions = new CalendarEventActions(
		plugin as never,
		{ registerDomEvent() {} } as never,
		root as never,
		(event) => {
			shown.push(event);
		},
	);
	actions.select(first);
	actions.copy(false, false);
	const pasting = actions.paste();
	actions.select(second);
	finishCopy({ ...first, id: 'copy' });
	await pasting;
	assert.equal(shown.length, 0, 'late copy completion does not reopen another event panel');
	await actions.remove();
	assert.deepEqual(removed, ['b'], 'deletion follows the latest selection');
});

test('new events prefer the account calendar over an enabled shared calendar and default to green', async () => {
	const { newEventCalendar, NEW_EVENT_COLOR_ID } = await import('../src/event-defaults');
	const { EventDetailsPanel } = await import('../src/event-details');
	const { eventDraft, newEventDraftInput } = await import('../src/event-editing');
	const { EventModal } = await import('../src/modal');
	const settings = {
		account: 'me@example.com',
		calendars: {
			shared: { name: 'Reading group', enabled: true, color: '#f09300' },
			'me@example.com': { name: 'Personal', enabled: true, color: '#111111' },
		},
	};
	assert.equal(newEventCalendar(settings), 'me@example.com');
	assert.equal(NEW_EVENT_COLOR_ID, '10');
	let shown: any;
	const plugin = { settings, app: {}, cache: { calendar: () => ({ labels: [] }) } };
	const panel = Object.assign(Object.create(EventDetailsPanel.prototype), {
		plugin,
		newEvents: new Set(),
		containerEl: { querySelector: () => ({ focus() {} }) },
		show: (event: unknown) => {
			shown = event;
		},
	}) as { create: (range: unknown) => void };
	panel.create({ start: '2026-10-23T09:00:00', end: '2026-10-23T10:00:00', allDay: false });
	assert.equal(shown.calendarId, 'me@example.com');
	assert.equal(shown.colorId, '10');
	const draft = eventDraft(shown);
	draft.title = 'A new task';
	const input = newEventDraftInput(shown, draft);
	assert.equal(toGoogle(input, false).colorId, '10');
	const modal = new EventModal(plugin as never, {}) as unknown as {
		calendarId: string;
		input: () => unknown;
		title: string;
	};
	assert.equal(modal.calendarId, 'me@example.com');
	modal.title = 'New from API';
	assert.equal((modal.input() as { colorId: string }).colorId, '10');
});

test('typing into the rendered new-event title autosaves a green event in the personal calendar', async () => {
	const { EventDetailsPanel } = await import('../src/event-details');
	const tasks = new Map<number, () => void>();
	let timerId = 0;
	const doc = {
		activeElement: null,
		defaultView: {
			setTimeout: (fn: () => void) => {
				tasks.set(++timerId, fn);
				return timerId;
			},
			clearTimeout: (id: number) => {
				tasks.delete(id);
			},
		},
	};
	class Element {
		children: Element[] = [];
		parentElement: Element | null = null;
		classes = new Set<string>();
		value = '';
		text = '';
		hidden = false;
		oninput?: () => void;
		constructor(options: { cls?: string | string[]; text?: string } = {}) {
			for (const name of Array.isArray(options.cls)
				? options.cls
				: (options.cls ?? '').split(' '))
				this.classes.add(name);
			this.text = options.text ?? '';
		}
		get ownerDocument() {
			return doc;
		}
		createDiv(options: { cls?: string | string[]; text?: string } = {}) {
			const el = new Element(options);
			this.appendChild(el);
			return el;
		}
		createEl(_tag: string, options: { cls?: string | string[]; text?: string } = {}) {
			return this.createDiv(options);
		}
		createSpan(options: { cls?: string | string[]; text?: string }) {
			return this.createDiv(options);
		}
		appendChild(node: unknown) {
			if (!(node instanceof Element)) return;
			if (node.parentElement)
				node.parentElement.children = node.parentElement.children.filter(
					(child) => child !== node,
				);
			node.parentElement = this;
			this.children.push(node);
		}
		empty() {
			this.children = [];
		}
		setText(text: string) {
			this.text = text;
		}
		setCssProps() {}
		addClass(name: string) {
			this.classes.add(name);
		}
		toggleClass(name: string, active: boolean) {
			if (active) this.classes.add(name);
			else this.classes.delete(name);
		}
		focus() {}
		querySelector(selector: string): Element | undefined {
			for (const child of this.children) {
				if (child.classes.has(selector.slice(1))) return child;
				const nested = child.querySelector(selector);
				if (nested) return nested;
			}
			return undefined;
		}
	}
	const root = new Element();
	const events: Record<string, ReturnType<typeof fromGoogle>> = {};
	const inserts: unknown[][] = [];
	const plugin = {
		settings: {
			account: 'personal',
			calendars: {
				shared: { name: 'Group', enabled: true },
				personal: { name: 'Me', enabled: true },
			},
		},
		cache: { calendar: () => ({ events, labels: [] }) },
		calendars: {
			insert: async (calendar: string, input: Parameters<typeof toGoogle>[0], id: string) => {
				inserts.push([calendar, toGoogle(input, false), id]);
				return (events[id] = {
					...input,
					calendarId: calendar,
					id,
					etag: 'fresh',
					recurringEventId: null,
				} as ReturnType<typeof fromGoogle>);
			},
		},
		notifyChanged() {},
	};
	const panel = new EventDetailsPanel(root as never, plugin as never, () => {});
	panel.create({
		start: '2026-10-23T12:45:00-05:00',
		end: '2026-10-23T14:15:00-05:00',
		allDay: false,
	});
	const title = root.querySelector('.gcal-event-title-input');
	assert(title);
	title.value = 'Build portfolio';
	title.oninput?.();
	assert.equal(tasks.size, 1);
	assert.equal(inserts.length, 0);
	for (const callback of [...tasks.values()]) callback();
	tasks.clear();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inserts.length, 1);
	assert.equal(inserts[0]?.[0], 'personal');
	assert.equal(
		(inserts[0]?.[1] as Record<string, unknown> | undefined)?.summary,
		'Build portfolio',
	);
	assert.equal((inserts[0]?.[1] as Record<string, unknown> | undefined)?.colorId, '10');
	assert.equal(
		root.querySelector('.gcal-event-title-input'),
		title,
		'saving keeps the original input and cursor',
	);
	assert.equal(root.children[1]?.text, 'Saved', 'save feedback is directly under the heading');
});
