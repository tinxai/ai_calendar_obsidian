// End-to-end checks against the fake Google backend. Results land in window.__e2e.
(async () => {
	const out = (window.__e2e = { steps: [], done: false });
	const plugin = app.plugins.getPlugin('google-cal-sync');
	const F = window.__fake;
	const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
	const step = async (name, fn) => {
		try {
			const detail = await fn();
			out.steps.push({ name, ok: true, detail });
		} catch (e) {
			out.steps.push({
				name,
				ok: false,
				detail: String(e && e.message ? e.message : e),
			});
		}
	};
	const assert = (c, msg) => {
		if (!c) throw new Error(msg);
	};
	const sync = () => plugin.sync({ force: true });
	const cacheOf = (c) => plugin.cache.calendar(c);
	// Only blocks on screen: a hidden block (the editing view behind reading view, a background tab) defers its redraw.
	const visibleBlocks = () =>
		[...document.querySelectorAll('.gcal')].filter((r) => r.offsetWidth > 0);
	const uiTitles = () =>
		visibleBlocks()
			.flatMap((r) => [...r.querySelectorAll('.fc-event')])
			.map((e) => e.textContent.trim());
	const fm = (path) =>
		app.metadataCache.getFileCache(app.vault.getFileByPath(path))?.frontmatter ?? {};
	const waitFor = async (pred, ms = 6000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (pred()) return true;
			await sleep(200);
		}
		return false;
	};
	const now = () => new Date().toISOString();
	const ahead = (days, hours = 0) => {
		const t = new Date();
		return new Date(t.getFullYear(), t.getMonth(), t.getDate() + days, hours);
	};
	/** Local date `days` from today, YYYY-MM-DD, so the event stays in the view the calendar opens on. */
	const day = (days) => {
		const d = ahead(days);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};
	const at = (days, hours) => ahead(days, hours).toISOString();
	const notesIn = (folder) =>
		app.vault.getFiles().filter((f) => f.path.startsWith(`10-projects/${folder}/tasks/`));
	const allTasks = () => Object.values(F.tasks).flatMap((l) => Object.values(l));
	const backlinkTo = (path) =>
		`obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;
	/** Shows the month holding `date` (YYYY-MM-DD) in every gcal block. The fixtures use fixed September 2026 dates. */
	const showMonth = async (date) => {
		const today = new Date();
		const [y, m] = date.split('-').map(Number);
		const diff = y * 12 + m - 1 - (today.getFullYear() * 12 + today.getMonth());
		for (const root of document.querySelectorAll('.gcal')) {
			root.querySelector('.fc-today-button')?.click();
			const button = root.querySelector(diff < 0 ? '.fc-prev-button' : '.fc-next-button');
			for (let i = 0; i < Math.abs(diff); i++) button?.click();
		}
		await sleep(300);
	};
	/** Pretends `key` went missing longer ago than the grace period, so the next sync acts on it. */
	const expireAbsence = (key) => {
		const s = plugin.cache.taskState();
		s.absent[key] = Date.now() - 11 * 60_000;
		plugin.cache.saveTaskState(s);
	};

	await step('initial sync clears stale error', async () => {
		await sync();
		assert(plugin.status.lastError === '', 'lastError: ' + plugin.status.lastError);
		assert(Object.keys(cacheOf('primary').events).length === 2, 'primary cache has 2 events');
		return { lastSyncAt: plugin.status.lastSyncAt };
	});

	let created;
	await step('insert event (modal save path)', async () => {
		created = await plugin.calendars.insert('primary', {
			title: 'E2E created',
			start: at(1, 10),
			end: at(1, 11),
			allDay: false,
			description: 'd',
		});
		assert(created.id && created.etag, 'created has id/etag');
		assert(F.events.primary[created.id].summary === 'E2E created', 'fake has event');
		assert(cacheOf('primary').events[created.id], 'cache has event');
		plugin.notifyChanged();
		assert(
			await waitFor(() => uiTitles().some((t) => t.includes('E2E created'))),
			'UI shows new event',
		);
		return created.id;
	});

	await step('patch event (drag/resize path) with If-Match', async () => {
		const before = F.events.primary[created.id].etag;
		const ev = await plugin.calendars.patch('primary', created.id, created.etag, {
			start: day(2),
			end: day(3),
			allDay: true,
		});
		assert(
			ev.allDay === true && ev.start === day(2),
			'now all-day the day after tomorrow: ' + JSON.stringify(ev),
		);
		assert(F.events.primary[created.id].etag !== before, 'etag rotated');
		assert(!('dateTime' in F.events.primary[created.id].start), 'dateTime cleared on Google');
		created = ev;
		return ev;
	});

	await step('patch with stale etag → 412, cache refreshed', async () => {
		let threw = null;
		try {
			await plugin.calendars.patch('primary', created.id, '"stale"', {
				title: 'should not apply',
			});
		} catch (e) {
			threw = e;
		}
		assert(threw && threw.status === 412, 'threw 412: ' + threw);
		assert(F.events.primary[created.id].summary === 'E2E created', 'title untouched on Google');
		assert(cacheOf('primary').events[created.id].title === 'E2E created', 'cache still fresh');
		return threw.message;
	});

	await step('Google-side edit and delete arrive via incremental sync', async () => {
		const e = F.events.primary[created.id];
		e.summary = 'Renamed on Google';
		e.etag = '"g1"';
		F.changes.primary.push(JSON.parse(JSON.stringify(e)));
		const victim = Object.values(F.events['home@group.calendar.google.com'])[0];
		delete F.events['home@group.calendar.google.com'][victim.id];
		F.changes['home@group.calendar.google.com'].push({
			...victim,
			status: 'cancelled',
		});
		const logLen = F.log.length;
		await sync();
		const calls = F.log
			.slice(logLen)
			.filter((l) => l.url.includes('/events?'))
			.map((l) => l.url);
		assert(
			calls.every((u) => u.includes('syncToken=')),
			'all event calls incremental: ' + calls.join(' | '),
		);
		assert(
			cacheOf('primary').events[created.id].title === 'Renamed on Google',
			'rename pulled',
		);
		assert(!cacheOf('home@group.calendar.google.com').events[victim.id], 'cancelled removed');
		return calls.length;
	});

	await step('410 → full resync', async () => {
		F.expireSyncToken = true;
		const logLen = F.log.length;
		await sync();
		F.expireSyncToken = false;
		const calls = F.log.slice(logLen).filter((l) => l.url.includes('/events?'));
		assert(
			calls.some((l) => l.status === 410),
			'saw 410',
		);
		assert(
			calls.some((l) => l.url.includes('timeMin=')),
			'full sync followed',
		);
		assert(plugin.status.lastError === '', 'no error after resync: ' + plugin.status.lastError);
		assert(Object.keys(cacheOf('primary').events).length === 3, 'primary has 3 events');
		return calls.map((l) => l.status);
	});

	await step('delete event', async () => {
		await plugin.calendars.remove('primary', created.id);
		assert(!F.events.primary[created.id], 'gone on Google');
		assert(!cacheOf('primary').events[created.id], 'gone in cache');
		return 'ok';
	});

	// ---- Tasks ----
	const listTest = plugin.settings.taskLists['Test Project'];
	const listSecond = plugin.settings.taskLists['Second Project'];
	const taskOf = (title) =>
		Object.values(F.tasks)
			.flatMap((l) => Object.values(l))
			.find((t) => t.title === title);

	await step('Google completes a task → note becomes done', async () => {
		await sleep(50);
		const t = taskOf('Write the README');
		t.status = 'completed';
		t.completed = now();
		t.updated = now();
		await sync();
		assert(
			await waitFor(
				() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'done',
			),
			'note status done',
		);
		return t.id;
	});

	await step('Google un-completes (needsAction, newer) → done note becomes backlog', async () => {
		await sleep(1100);
		const t = taskOf('Write the README');
		t.status = 'needsAction';
		delete t.completed;
		t.updated = now();
		await sync();
		assert(
			await waitFor(
				() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'backlog',
			),
			'note status backlog',
		);
		return 'ok';
	});

	await step('note edited later than Google → pushed', async () => {
		await sleep(1100);
		const file = app.vault.getFileByPath('10-projects/Test Project/tasks/Write the README.md');
		await app.fileManager.processFrontMatter(file, (f) => {
			f.status = 'active';
			f.due = '2026-09-20';
		});
		await sleep(300);
		await sync();
		const t = taskOf('Write the README');
		assert(
			t.status === 'needsAction' && t.due === '2026-09-20T00:00:00.000Z',
			'pushed due: ' + JSON.stringify(t),
		);
		return t.due;
	});

	await step('Google renames a task (newer) → note title and file renamed', async () => {
		await sleep(1100);
		const t = taskOf('Wait for review');
		t.title = 'Wait for review: v2';
		t.updated = now();
		await sync();
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/Wait for review v2.md');
		assert(f, 'renamed file exists (colon stripped)');
		assert(
			await waitFor(() => fm(f.path).title === 'Wait for review: v2'),
			'title frontmatter updated',
		);
		return f.path;
	});

	await step('new task on Google → note imported with backlink', async () => {
		const t = {
			id: 'phone1',
			title: 'From phone',
			notes: 'bring the receipts',
			status: 'needsAction',
			due: '2026-09-22T00:00:00.000Z',
			updated: now(),
		};
		F.tasks[listTest][t.id] = t;
		await sync();
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/From phone.md');
		assert(f, 'note created');
		assert(await waitFor(() => fm(f.path).google_task_id === 'phone1'), 'google_task_id set');
		assert(
			fm(f.path).status === 'backlog' && fm(f.path).due === '2026-09-22',
			'fields: ' + JSON.stringify(fm(f.path)),
		);
		assert(
			(t.notes || '').startsWith('obsidian://open?vault='),
			'backlink patched: ' + t.notes,
		);
		assert(t.notes.includes('bring the receipts'), 'phone text kept: ' + t.notes);
		return f.path;
	});

	await step('note deleted → Google task deleted after the grace period', async () => {
		const t = taskOf('Ship it');
		await app.fileManager.trashFile(
			app.vault.getFileByPath('10-projects/Second Project/tasks/Ship it.md'),
		);
		await sleep(300);
		await sync();
		assert(F.tasks[listSecond][t.id], 'task kept while the deletion may still be travelling');
		expireAbsence(`note:${t.id}`);
		await sync();
		assert(!F.tasks[listSecond][t.id], 'task removed on Google');
		return t.id;
	});

	await step('note moved to another project → tasks.move', async () => {
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/From phone.md');
		await app.fileManager.renameFile(f, '10-projects/Second Project/tasks/From phone.md');
		await sleep(300);
		const logLen = F.log.length;
		await sync();
		assert(
			F.log
				.slice(logLen)
				.some((l) => l.url.includes('/move?destinationTasklist=' + listSecond)),
			'move called',
		);
		assert(
			F.tasks[listSecond].phone1 && !F.tasks[listTest].phone1,
			'task now in Second Project list',
		);
		return 'ok';
	});

	await step('Google deleted a task → note re-creates it after the grace period', async () => {
		delete F.tasks[listSecond].phone1;
		await sync();
		assert(
			fm('10-projects/Second Project/tasks/From phone.md').google_task_id === 'phone1' &&
				!allTasks().some((t) => t.title === 'From phone'),
			'not re-created while a note deletion may still be travelling',
		);
		expireAbsence('task:phone1');
		await sync();
		assert(
			await waitFor(
				() =>
					fm('10-projects/Second Project/tasks/From phone.md').google_task_id !==
					'phone1',
			),
			'new id written',
		);
		const gid = fm('10-projects/Second Project/tasks/From phone.md').google_task_id;
		assert(gid && F.tasks[listSecond][gid], 'new task exists: ' + gid);
		return gid;
	});

	// ---- Issue #10: several devices, one vault sync behind another ----

	await step('task made from a note this device has not received is not imported', async () => {
		const t = {
			id: 'elsewhere1',
			title: 'Made on another device',
			notes: backlinkTo('10-projects/Test Project/tasks/Made on another device.md'),
			status: 'needsAction',
			updated: now(),
		};
		F.tasks[listTest][t.id] = t;
		const before = notesIn('Test Project').length;
		await sync();
		await sleep(300);
		assert(notesIn('Test Project').length === before, 'no note imported');
		assert(F.tasks[listTest].elsewhere1, 'task left alone');
		return before;
	});

	await step('the note arriving later pairs with its task through the back-link', async () => {
		const path = '10-projects/Test Project/tasks/Made on another device.md';
		const tasksBefore = allTasks().length;
		await app.vault.create(
			path,
			'---\ntype: Task\ntitle: Made on another device\nstatus: active\n---\n',
		);
		await sleep(2500); // the note change also triggers a sync of its own
		await sync();
		assert(allTasks().length === tasksBefore, 'no second task created');
		assert(
			plugin.cache.taskIndex().elsewhere1 === path,
			'paired: ' + JSON.stringify(plugin.cache.taskIndex()),
		);
		return path;
	});

	await step('an empty task index does not re-import tasks made from notes', async () => {
		plugin.cache.saveTaskIndex({});
		plugin.cache.saveTaskState({ base: {}, absent: {} });
		const notesBefore = notesIn('Test Project').length + notesIn('Second Project').length;
		const tasksBefore = allTasks().length;
		await sync();
		await sleep(300);
		assert(
			notesIn('Test Project').length + notesIn('Second Project').length === notesBefore,
			'no notes imported',
		);
		assert(allTasks().length === tasksBefore, 'no tasks created');
		return notesBefore;
	});

	await step('a copy claiming the same task creates nothing and is reported', async () => {
		const src = app.vault.getFileByPath('10-projects/Test Project/tasks/Write the README.md');
		const tasksBefore = allTasks().length;
		const copy = await app.vault.copy(
			src,
			'10-projects/Test Project/tasks/Write the README (1).md',
		);
		await sleep(2500); // let the sync the copy triggers finish before calling the mirror directly
		await waitFor(() => !plugin.status.syncing);
		const r = await plugin.tasks.sync();
		assert(allTasks().length === tasksBefore, 'no task for the copy');
		assert(
			r.duplicates.length === 1 && r.duplicates[0] === copy.path,
			'copy reported, original kept: ' + JSON.stringify(r.duplicates),
		);
		await app.vault.delete(copy);
		return r.duplicates;
	});

	await step('Clear cache keeps the task index', async () => {
		const index = plugin.cache.taskIndex();
		plugin.clearCache();
		assert(
			JSON.stringify(plugin.cache.taskIndex()) === JSON.stringify(index) &&
				Object.keys(index).length > 0,
			'index survived',
		);
		return Object.keys(index).length;
	});

	await step(
		'phone completes while a note moves its due date: both changes survive',
		async () => {
			await sync(); // settle the base
			await sleep(1100);
			const t = taskOf('Wait for review: v2');
			t.status = 'completed';
			t.completed = now();
			t.updated = now();
			await sleep(1100);
			const file = app.vault.getFileByPath(
				'10-projects/Test Project/tasks/Wait for review v2.md',
			);
			await app.fileManager.processFrontMatter(file, (f) => {
				f.due = '2026-10-20';
			});
			await sleep(500);
			await sync();
			assert(
				await waitFor(() => fm(file.path).status === 'done'),
				'completion reached the note: ' + JSON.stringify(fm(file.path)),
			);
			assert(t.due === '2026-10-20T00:00:00.000Z', 'due reached Google: ' + t.due);
			assert(t.status === 'completed', 'Google stays completed');
			return 'ok';
		},
	);

	await step('mirror off → no Tasks API calls', async () => {
		plugin.settings.mirror = false;
		const logLen = F.log.length;
		await sync();
		plugin.settings.mirror = true;
		assert(!F.log.slice(logLen).some((l) => l.url.startsWith('/tasks/')), 'no tasks calls');
		return 'ok';
	});

	await step('request budget: one list call per calendar and per project', async () => {
		const logLen = F.log.length;
		await sync();
		const calls = F.log.slice(logLen).map((l) => l.method + ' ' + l.url.split('?')[0]);
		const events = calls.filter((c) => c.endsWith('/events')).length;
		const tasks = calls.filter((c) => /\/tasks$/.test(c)).length;
		assert(events === 3 && tasks === 2 && calls.length === 5, 'calls: ' + calls.join(' | '));
		return calls.length;
	});

	await step('calendar toggle off hides its events and persists', async () => {
		for (const b of document.querySelectorAll('.gcal .fc-today-button')) b.click();
		assert(
			await waitFor(() => uiTitles().some((t) => t.includes('Offsite'))),
			'Offsite shown first',
		);
		plugin.settings.calendars['work@group.calendar.google.com'].enabled = false;
		await plugin.saveSettings();
		plugin.notifyChanged();
		assert(
			await waitFor(() => !uiTitles().some((t) => t.includes('Offsite'))),
			'Offsite hidden',
		);
		const saved = JSON.parse(
			await app.vault.adapter.read(
				app.vault.configDir + '/plugins/google-cal-sync/data.json',
			),
		);
		assert(saved.calendars['work@group.calendar.google.com'].enabled === false, 'persisted');
		plugin.settings.calendars['work@group.calendar.google.com'].enabled = true;
		await plugin.saveSettings();
		plugin.notifyChanged();
		return 'ok';
	});

	await step('task checkbox click → note done → pushed to Google', async () => {
		await sleep(1100);
		await showMonth('2026-09-15');
		const box = visibleBlocks()
			.flatMap((r) => [...r.querySelectorAll('.gcal-task')])
			.find((e) => e.textContent.includes('Write the README'))
			?.querySelector('input');
		assert(box, 'checkbox found');
		box.click();
		assert(
			await waitFor(
				() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'done',
			),
			'note done',
		);
		assert(
			await waitFor(() => taskOf('Write the README').status === 'completed', 8000),
			'Google completed',
		);
		return 'ok';
	});

	// The public API (issue #13): the same modal as the calendar, opened from outside it.
	const modalEl = () => document.querySelector('.modal.gcal-modal');
	const closeModals = () => {
		for (const b of document.querySelectorAll('.modal.gcal-modal button'))
			if (b.textContent === 'Cancel') b.click();
	};
	const typeTitle = (text) => {
		const input = modalEl().querySelector('.gcal-modal-title');
		input.value = text;
		input.dispatchEvent(new Event('input'));
	};
	const settled = (p) => Promise.race([p.then(() => true), sleep(3000).then(() => false)]);

	await step(
		'api.openEvent opens the edit modal; saving reaches Google, the cache and listeners',
		async () => {
			await sync();
			const ev = Object.values(cacheOf('primary').events).find(
				(e) => e.title === 'Weekly meeting',
			);
			assert(ev, 'cached event found');
			let heard = 0;
			const listener = () => heard++;
			plugin.addListener(listener);
			try {
				const closed = plugin.api.openEvent('primary', ev.id);
				assert(await waitFor(() => modalEl()), 'modal opened');
				assert(
					modalEl().querySelector('.modal-title').textContent === 'Edit event',
					'edit title',
				);
				assert(
					modalEl().querySelector('.gcal-modal-title').value === 'Weekly meeting',
					'prefilled',
				);
				typeTitle('Weekly meeting (api)');
				modalEl().querySelector('button.mod-cta').click();
				assert(await settled(closed), 'promise resolves when the modal closes');
				assert(!modalEl(), 'modal closed');
				assert(
					F.events.primary[ev.id].summary === 'Weekly meeting (api)',
					'Google updated',
				);
				assert(
					cacheOf('primary').events[ev.id].title === 'Weekly meeting (api)',
					'cache updated',
				);
				assert(heard > 0, 'listeners called');
			} finally {
				plugin.removeListener(listener);
				closeModals();
			}
			return ev.id;
		},
	);

	await step('api.openEvent on a recurring instance shows the one-occurrence note', async () => {
		const ev = Object.values(cacheOf('primary').events).find((e) => e.recurringEventId);
		assert(ev, 'recurring instance cached');
		const closed = plugin.api.openEvent('primary', ev.id);
		assert(await waitFor(() => modalEl()), 'modal opened');
		assert(modalEl().querySelector('.gcal-modal-note'), 'occurrence note shown');
		closeModals();
		assert(await settled(closed), 'cancel resolves');
		return ev.id;
	});

	await step('api.openEvent rejects an id the cache does not have', async () => {
		let error;
		await plugin.api.openEvent('primary', 'no-such-event').catch((e) => (error = e));
		assert(error && /no-such-event/.test(error.message), 'rejected: ' + error);
		assert(!modalEl(), 'no modal');
		return error.message;
	});

	await step(
		'api.createEvent with a date opens an all-day New event that saves to Google',
		async () => {
			const date = day(3);
			const closed = plugin.api.createEvent({ date });
			assert(await waitFor(() => modalEl()), 'modal opened');
			assert(
				modalEl().querySelector('.modal-title').textContent === 'New event',
				'new title',
			);
			assert(modalEl().querySelector('.checkbox-container.is-enabled'), 'all day on');
			const dates = [...modalEl().querySelectorAll('input[type=date]')].map((i) => i.value);
			assert(dates.join() === `${date},${date}`, 'dates: ' + dates.join());
			typeTitle('API all-day');
			modalEl().querySelector('button.mod-cta').click();
			assert(await settled(closed), 'resolves on save');
			const made = Object.values(F.events.primary).find((e) => e.summary === 'API all-day');
			assert(
				made && made.start.date === date && made.end.date === day(4),
				'Google: ' + JSON.stringify(made?.start),
			);
			return made.id;
		},
	);

	await step(
		'api.createEvent with a time and calendar prefills both; bad input rejects',
		async () => {
			const closed = plugin.api.createEvent({
				date: day(2),
				start: '14:00',
				calendarId: 'work@group.calendar.google.com',
			});
			assert(await waitFor(() => modalEl()), 'modal opened');
			const times = [...modalEl().querySelectorAll('input[type=time]')].map((i) => i.value);
			assert(times.join() === '14:00,15:00', 'times: ' + times.join());
			assert(
				modalEl().querySelector('select').value === 'work@group.calendar.google.com',
				'calendar',
			);
			assert(!modalEl().querySelector('.checkbox-container.is-enabled'), 'all day off');
			const before = Object.keys(F.events['work@group.calendar.google.com']).length;
			closeModals();
			assert(await settled(closed), 'cancel resolves');
			assert(
				Object.keys(F.events['work@group.calendar.google.com']).length === before,
				'nothing created',
			);
			let error;
			await plugin.api.createEvent({ date: '2026-02-30' }).catch((e) => (error = e));
			assert(error && /date/.test(error.message), 'bad date rejected: ' + error);
			assert(!modalEl(), 'no modal for bad input');
			return 'ok';
		},
	);

	await step(
		'api on a device without a login shows the calendar notice and opens nothing',
		async () => {
			const token = plugin.settings.refreshToken;
			const notices = () =>
				[...document.querySelectorAll('.notice')].filter((n) =>
					/Log in to Google/.test(n.textContent),
				).length;
			const shown = notices();
			plugin.settings.refreshToken = '';
			try {
				await plugin.api.createEvent({ date: day(1) });
				assert(!modalEl(), 'no modal');
				assert(notices() > shown, 'notice shown');
			} finally {
				plugin.settings.refreshToken = token;
			}
			return 'ok';
		},
	);

	out.done = true;
})();
