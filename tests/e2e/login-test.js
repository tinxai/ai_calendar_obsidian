// Exercises the loopback login up to (but not including) Google consent. Results in window.__login.
(async () => {
	const out = (window.__login = { steps: [], done: false });
	const plugin = app.plugins.getPlugin('google-cal-sync');
	const http = require('http');
	const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
	const origOpen = window.open;
	const get = (url) =>
		new Promise((resolve, reject) => {
			http.get(url, (res) => {
				let body = '';
				res.on('data', (c) => (body += c));
				res.on('end', () => resolve({ status: res.statusCode, body }));
			}).on('error', reject);
		});
	const step = async (name, fn) => {
		try {
			out.steps.push({ name, ok: true, detail: await fn() });
		} catch (e) {
			out.steps.push({
				name,
				ok: false,
				detail: String(e && e.message ? e.message : e),
			});
		}
	};
	const assert = (c, m) => {
		if (!c) throw new Error(m);
	};
	app.secretStorage.setSecret('google-cal-sync-passphrase', 'e2e-passphrase');
	const startLogin = async () => {
		let captured = '';
		window.open = (u) => {
			captured = u;
			return null;
		};
		const promise = plugin.auth.login();
		promise.catch(() => {});
		await sleep(400);
		window.open = origOpen;
		assert(captured, 'window.open was called with the Google URL');
		const u = new URL(captured);
		return {
			u,
			promise,
			redirect: u.searchParams.get('redirect_uri'),
			state: u.searchParams.get('state'),
		};
	};

	await step('auth URL has PKCE, state, offline access, loopback redirect', async () => {
		const { u, promise, redirect, state } = await startLogin();
		const q = u.searchParams;
		assert(
			u.origin + u.pathname === 'https://accounts.google.com/o/oauth2/v2/auth',
			'endpoint',
		);
		assert(q.get('client_id') === plugin.settings.clientId, 'client_id');
		assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect), 'redirect ' + redirect);
		assert(
			q.get('code_challenge_method') === 'S256' &&
				(q.get('code_challenge') || '').length >= 43,
			'challenge',
		);
		assert(
			q.get('access_type') === 'offline' && q.get('prompt') === 'consent',
			'offline+consent',
		);
		const scope = q.get('scope');
		assert(/auth\/calendar(\s|$)/.test(scope) && scope.includes('auth/tasks'), 'scopes');
		assert(state.length >= 16, 'state');
		assert(plugin.auth.pending === true, 'pending while waiting');
		// wrong state → 404, ignored, the login keeps waiting
		const r = await get(`${redirect}/?state=WRONG&code=abc`);
		assert(r.status === 404, 'foreign request answered 404: ' + r.status);
		assert(plugin.auth.pending === true, 'still pending after a foreign request');
		const r2 = await get(`${redirect}/?error=access_denied`);
		assert(r2.status === 404, 'error without state ignored: ' + r2.status);
		// the real redirect with an error → rejected, server closed
		const r3 = await get(`${redirect}/?state=${state}&error=cancel`);
		assert(
			r3.status === 200 && r3.body.includes('Login failed'),
			'failure page: ' + r3.body.slice(0, 80),
		);
		let err = null;
		await promise.catch((e) => (err = e));
		assert(err && err.message === 'cancel', 'rejected with the error: ' + err);
		assert(plugin.auth.pending === false, 'pending reset');
		let closed = false;
		await get(`${redirect}/`).catch(() => (closed = true));
		assert(closed, 'loopback server closed after login attempt');
		return { redirect, challengeLen: q.get('code_challenge').length };
	});

	await step(
		'Google error on redirect → surfaced, markup in it never reaches the page',
		async () => {
			const { promise, redirect, state } = await startLogin();
			const r = await get(
				`${redirect}/?state=${state}&error=access_denied${encodeURIComponent('<script>alert(1)</script>')}`,
			);
			assert(!r.body.includes('<script'), 'error is sanitised: ' + r.body.slice(0, 200));
			let err = null;
			await promise.catch((e) => (err = e));
			assert(
				err && err.message === 'access_deniedscriptalert1script',
				'error surfaced without markup: ' + err,
			);
			return 'ok';
		},
	);

	await step('login refuses to start without a sync passphrase', async () => {
		const saved = app.secretStorage.getSecret('google-cal-sync-passphrase');
		app.secretStorage.setSecret('google-cal-sync-passphrase', '');
		let err = null;
		await plugin.auth.login().catch((e) => (err = e));
		app.secretStorage.setSecret('google-cal-sync-passphrase', saved);
		assert(err && /passphrase/.test(err.message), 'refused: ' + err);
		assert(plugin.auth.pending === false, 'nothing left pending');
		return 'ok';
	});

	await step(
		'correct state + bogus code → token exchange hits Google and fails cleanly',
		async () => {
			const { promise, redirect, state } = await startLogin();
			const r = await get(`${redirect}/?state=${state}&code=bogus-code`);
			assert(r.body.includes('Connected'), 'success page shown before exchange');
			let err = null;
			await promise.catch((e) => (err = e));
			assert(err, 'exchange rejected');
			assert(
				!/connection lost/i.test(err.message),
				'login error is not the refresh-token message: ' + err.message,
			);
			assert(
				plugin.settings.refreshToken === 'fake-refresh-token',
				'refresh token untouched by failed login',
			);
			return err.message;
		},
	);

	await step('non-root path on loopback → 404', async () => {
		const { promise, redirect, state } = await startLogin();
		const r = await get(`${redirect}/favicon.ico`);
		assert(r.status === 404, '404 for other paths');
		await get(`${redirect}/?state=${state}&error=cancel`);
		await promise.catch(() => {});
		return 'ok';
	});

	out.done = true;
})();
