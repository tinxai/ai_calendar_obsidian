// Fake Google backend injected into the running Obsidian for end-to-end checks without a real login.
// Replaces GoogleClient.send (transport) so real GoogleError/status handling stays in play.
(() => {
	const plugin = app.plugins.getPlugin('google-cal-sync');
	const now = () => new Date().toISOString();
	let seq = 1;
	const id = (p) => `${p}${seq++}`;
	const F = (window.__fake = {
		log: [],
		calendars: {
			primary: {
				id: 'primary',
				summary: 'tester@example.com',
				backgroundColor: '#3B7DD8',
				primary: true,
			},
			'work@group.calendar.google.com': {
				id: 'work@group.calendar.google.com',
				summary: 'Work',
				backgroundColor: '#D85B8B',
			},
			'home@group.calendar.google.com': {
				id: 'home@group.calendar.google.com',
				summary: 'Home',
				backgroundColor: '#33B679',
			},
		},
		events: {}, // calId -> { eventId -> event }
		changes: {}, // calId -> [event snapshots in order]
		expireSyncToken: false,
		lists: {}, // listId -> { id, title }
		tasks: {}, // listId -> { taskId -> task }
	});
	const cal = (c) => ((F.events[c] ??= {}), (F.changes[c] ??= []), F.events[c]);
	const pushChange = (c, ev) => F.changes[c].push(JSON.parse(JSON.stringify(ev)));
	const addEvent = (c, ev) => {
		const e = {
			id: id('evt'),
			etag: `"${seq++}"`,
			status: 'confirmed',
			...ev,
		};
		cal(c)[e.id] = e;
		pushChange(c, e);
		return e;
	};
	const today = new Date();
	const d = (off, h) => {
		const x = new Date(
			today.getFullYear(),
			today.getMonth(),
			today.getDate() + off,
			h ?? 0,
			0,
			0,
		);
		return h === undefined ? x.toISOString().slice(0, 10) : x.toISOString();
	};
	addEvent('primary', {
		summary: 'Weekly meeting',
		start: { dateTime: d(1, 10) },
		end: { dateTime: d(1, 11) },
		description: 'agenda',
	});
	addEvent('primary', {
		summary: 'Recurring standup',
		start: { dateTime: d(2, 9) },
		end: { dateTime: d(2, 9.5) },
		recurringEventId: 'rec1',
	});
	addEvent('work@group.calendar.google.com', {
		summary: 'Offsite',
		start: { date: d(3) },
		end: { date: d(5) },
	});
	addEvent('home@group.calendar.google.com', {
		summary: 'Dentist',
		start: { dateTime: d(-1, 14) },
		end: { dateTime: d(-1, 15) },
	});
	cal('primary');

	const err = (status, message) => ({
		status,
		text: JSON.stringify({ error: { code: status, message } }),
		headers: {},
	});
	const ok = (body) => ({
		status: body === undefined ? 204 : 200,
		text: body === undefined ? '' : JSON.stringify(body),
		headers: {},
	});

	function route(method, urlStr, opts) {
		const u = new URL(urlStr);
		const q = u.searchParams;
		const p = u.pathname;
		const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
		let m;
		if (p === '/calendar/v3/users/me/calendarList')
			return ok({ items: Object.values(F.calendars) });
		if ((m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/))) {
			const c = decodeURIComponent(m[1]);
			if (!F.calendars[c]) return err(404, 'Not Found');
			const store = cal(c);
			if (method === 'GET') {
				const tok = q.get('syncToken');
				if (tok) {
					if (F.expireSyncToken) return err(410, 'Sync token is no longer valid');
					const from = Number(tok.replace('st', ''));
					return ok({
						items: F.changes[c].slice(from),
						nextSyncToken: `st${F.changes[c].length}`,
					});
				}
				if (!q.get('timeMin') || q.get('singleEvents') !== 'true')
					return err(400, 'full sync must pass timeMin and singleEvents');
				return ok({
					items: Object.values(store),
					nextSyncToken: `st${F.changes[c].length}`,
				});
			}
			if (method === 'POST') {
				if (!body.summary || !body.start || !body.end)
					return err(400, 'summary/start/end required');
				return ok(addEvent(c, body));
			}
		}
		if ((m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/))) {
			const c = decodeURIComponent(m[1]);
			const e = cal(c)[decodeURIComponent(m[2])];
			if (!e) return err(404, 'Not Found');
			if (method === 'GET') return ok(e);
			if (method === 'PATCH') {
				const im = (opts.headers ?? {})['If-Match'];
				if (im && im !== e.etag) return err(412, 'Precondition Failed');
				for (const [k, v] of Object.entries(body)) {
					if (k === 'start' || k === 'end') {
						e[k] = {};
						for (const [kk, vv] of Object.entries(v)) if (vv !== null) e[k][kk] = vv;
					} else e[k] = v;
				}
				e.etag = `"${seq++}"`;
				pushChange(c, e);
				return ok(e);
			}
			if (method === 'DELETE') {
				delete cal(c)[e.id];
				pushChange(c, { ...e, status: 'cancelled' });
				return ok();
			}
		}
		if (p === '/tasks/v1/users/@me/lists') {
			if (method === 'GET') return ok({ items: Object.values(F.lists) });
			const l = { id: id('list'), title: body.title };
			F.lists[l.id] = l;
			F.tasks[l.id] = {};
			return ok(l);
		}
		if ((m = p.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/))) {
			const l = decodeURIComponent(m[1]);
			if (!F.lists[l]) return err(404, 'Not Found');
			if (method === 'GET') {
				if (q.get('showHidden') !== 'true' || q.get('showCompleted') !== 'true')
					return err(400, 'expected showHidden/showCompleted');
				return ok({ items: Object.values(F.tasks[l]) });
			}
			const t = {
				id: id('task'),
				status: 'needsAction',
				updated: now(),
				...body,
			};
			F.tasks[l][t.id] = t;
			return ok(t);
		}
		if ((m = p.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)(\/move)?$/))) {
			const l = decodeURIComponent(m[1]);
			const t = F.tasks[l]?.[decodeURIComponent(m[2])];
			if (!t) return err(404, 'Not Found');
			if (m[3]) {
				const dest = q.get('destinationTasklist');
				if (!F.lists[dest]) return err(404, 'dest list');
				delete F.tasks[l][t.id];
				F.tasks[dest][t.id] = t;
				t.updated = now();
				return ok(t);
			}
			if (method === 'PATCH') {
				for (const [k, v] of Object.entries(body)) {
					if (v === null) delete t[k];
					else t[k] = v;
				}
				if (t.status === 'completed' && !t.completed) t.completed = now();
				if (t.status === 'needsAction') delete t.completed;
				t.updated = now();
				return ok(t);
			}
			if (method === 'DELETE') {
				delete F.tasks[l][t.id];
				return ok();
			}
		}
		return err(404, `no route ${method} ${p}`);
	}

	plugin.google.send = async (method, url, token, opts) => {
		const res = route(method, url, opts);
		F.log.push({
			method,
			url: url
				.replace('https://www.googleapis.com', '')
				.replace('https://tasks.googleapis.com', ''),
			status: res.status,
		});
		return res;
	};
	plugin.auth.token = async () => 'fake-token';
	plugin.settings.refreshToken = 'fake-refresh-token';
	void plugin.auth.unlock().then(() => plugin.notifyChanged()); // plain token → not locked, whatever this vault's keychain holds
	return 'fake google installed';
})();
