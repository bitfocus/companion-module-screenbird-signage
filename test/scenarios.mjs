// End-to-end scenarios: the packaged module against the mock API.
// Usage: NODE_EXTRA_CA_CERTS=<cert.pem> TEST_WORK_DIR=<dir> node test/scenarios.mjs <scenario>
// Exits with 0 when every check passed. test/run-all.sh builds the module and runs all scenarios.
import { pathToFileURL } from 'node:url'
import {
	create,
	log,
	sleep,
	state,
	status,
	sockets,
	moduleOpen,
	press,
	fb,
	waitFor,
	check,
	failed,
	passed,
	timers,
	TOKEN,
	MODULE_DIR,
} from './harness.mjs'
import { startMock, scene, apiError } from './mock.mjs'

const which = process.argv[2]
const m = await startMock()
const cfg = { apiUrl: m.url }
const openNow = () => sockets.filter((s) => s.state === 'open').length
const waitOpen = (n = 1, ms = 8000) => waitFor(() => openNow() >= n && status().status === 'ok', ms)
const statusesSince = (t0) =>
	state.statuses.filter((s) => s.at >= t0).map((s) => `${s.status}${s.message ? ':' + s.message : ''}`)
const seconds = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`
const html = { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>Login to Wi-Fi</html>' }
const e401 = apiError(401, 'invalid_token', 'The API token is missing, invalid or revoked.')
const event = (table) => ({ type: 'events', events: [{ table, op: 'update', row: {} }] })

/** The lowest text/background contrast ratio over all presets and their feedback styles. */
function worstPresetContrast() {
	const luminance = (c) => {
		const ch = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
		return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255)
	}
	const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
	let worst = 99
	let where = ''
	for (const [id, preset] of Object.entries(state.presets)) {
		for (const style of [preset.style, ...preset.feedbacks.map((f) => ({ ...preset.style, ...f.style }))]) {
			const r = ratio(style.color, style.bgcolor)
			if (r < worst) {
				worst = r
				where = `${id} ${style.color.toString(16)} on ${style.bgcolor.toString(16)}`
			}
		}
	}
	return { worst, where }
}

const scenarios = {
	async basic() {
		const inst = await create(cfg)
		check('start: socket open and status ok', !!(await waitOpen()))
		await sleep(1500)
		const ua = m.requests[0]?.ua
		check('User-Agent carries the version from package.json', ua === 'screenbird-companion/1.0.0', ua)
		check('X-Screenbird-Client is companion', m.requests[0]?.client === 'companion')
		const contentOption = state.actions.push.options[1]
		check(
			'content list loaded',
			contentOption.type === 'dropdown' && contentOption.choices.length === 2,
			JSON.stringify(contentOption.choices),
		)
		check(
			'sub-screens are targets',
			state.actions.push.options[0].choices.map((c) => c.label).join('|') ===
				'Screen 1|Screen 2 / Left|Screen 2 / Right',
		)
		check('next_scene without history is the first scene', state.vars.next_scene === 'Scene 1', state.vars.next_scene)

		// With an open socket a press only sends the POST; the new state arrives through the event (one refresh).
		const t0 = Date.now()
		const r = await press('scene_activate', { scene: m.scenes[1].id })
		await sleep(1800)
		const calls = m.reqs(t0)
		check(
			'press with open socket: no extra refresh besides the event',
			r.ok && calls.filter((c) => c.startsWith('GET /scenes')).length === 1 && calls[0].startsWith('POST'),
			JSON.stringify(calls),
		)

		// Without a socket (upgrade refused) a press refreshes right away.
		m.upgradePlan = Array(20).fill({ status: 503 })
		m.sockets.forEach((s) => s.sock.destroy())
		await waitFor(() => openNow() === 0, 3000)
		await sleep(1500)
		const t1 = Date.now()
		const r2 = await press('scene_release', { scene: m.scenes[1].id })
		await sleep(2500) // the refresh can come up to REFRESH_SPACING_MS (2 s) after the previous one
		const calls2 = m.reqs(t1)
		check(
			'press without socket: refreshes right away',
			r2.ok && calls2[0].startsWith('POST') && calls2.some((c) => c.startsWith('GET /scenes')),
			JSON.stringify(calls2),
		)
		await inst.destroy()

		log(
			'presets:',
			Object.keys(state.presets).length,
			'sections',
			JSON.stringify(state.structure.map((s) => [s.id, s.definitions.map((d) => d.presets.length)])),
		)
		const go = state.presets[`scene_${m.scenes[0].id}`]
		check(
			'partly live has its own background color',
			go.feedbacks[1].style.bgcolor !== go.style.bgcolor &&
				go.feedbacks[1].style.bgcolor !== go.feedbacks[0].style.bgcolor,
		)
		check(
			'NEXT preset shows the variable and a clean preview',
			state.presets.scene_next.style.text === 'NEXT\\n$(screenbird:next_scene)' &&
				state.presets.scene_next.previewStyle.text === 'NEXT\\nSCENE',
		)
		check('screen presets exist', !!state.presets[`screen_release_${m.screens[0].id}`])
	},

	async names() {
		m.scenes = [
			scene(1, { name: 'Pause' }),
			scene(2, { name: 'Price $(internal:time_hms) \\n test', color: 'orange' }),
			scene(3, { name: 'Pause', color: 'gray' }),
		]
		const inst = await create(cfg)
		await waitOpen()
		const labels = state.actions.scene_activate.options[0].choices.map((c) => c.label).join('|')
		check(
			'duplicate scene names are distinct',
			labels === 'Pause (1)|Price $(internal:time_hms) \\n test|Pause (2)',
			labels,
		)
		const preset = state.presets[`scene_${m.scenes[1].id}`]
		check(
			'$( and \\n in preset text are neutralized',
			!preset.style.text.includes('$(') && !preset.style.text.includes('\\n'),
			JSON.stringify(preset.style.text),
		)
		const { worst, where } = worstPresetContrast()
		check('contrast of all presets at least 4.5:1', worst >= 4.5, `worst ${worst.toFixed(2)} (${where})`)
		await inst.destroy()
	},

	async colors() {
		const colors = ['green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray']
		m.scenes = colors.map((c, i) => scene(i + 1, { color: c, name: c }))
		const inst = await create(cfg)
		await waitOpen()
		const { worst, where } = worstPresetContrast()
		check(
			'contrast of all 8 scene colors in every state at least 4.5:1',
			worst >= 4.5,
			`worst ${worst.toFixed(2)} (${where})`,
		)
		const hex = (c) => c.toString(16).padStart(6, '0')
		colors.forEach((c, i) => {
			const p = state.presets[`scene_${m.scenes[i].id}`]
			const [live, partial, changed] = p.feedbacks.map((f) => f.style)
			log(
				`${c.padEnd(6)} off ${hex(p.style.bgcolor)} / live ${hex(live.bgcolor)} text ${live.color ? 'white' : 'black'}` +
					` / partial ${hex(partial.bgcolor)} / changed ${hex(changed.bgcolor)} "${changed.text}"`,
			)
		})
		await inst.destroy()
	},

	async closecodes() {
		const inst = await create(cfg)
		await waitOpen()
		for (const code of [4001, 1013, 1006]) {
			const before = m.upgrades.length
			const t0 = Date.now()
			if (code === 1006) m.sockets.forEach((s) => s.sock.destroy())
			else m.closeAll(code, code === 4001 ? 'Heartbeat timeout' : 'Try again')
			const back = await waitFor(() => m.upgrades.length > before && openNow() === 1 && status().status === 'ok', 10000)
			const sts = statusesSince(t0)
			check(
				`close code ${code}: reconnects, never reports a revoked token`,
				!!back && !sts.some((s) => s.startsWith('authentication_failure')),
				`${seconds(t0)}, statuses ${JSON.stringify(sts)}`,
			)
		}

		// 4008: another connection with the same token took over; wait 30 s before a new socket.
		{
			const before = m.upgrades.length
			const t0 = Date.now()
			m.closeAll(4008, 'Too many connections')
			await sleep(5000)
			check(
				'4008: does not reconnect at once (waits 30 s)',
				m.upgrades.length === before && timers.some((x) => x.at >= t0 && x.ms === 30000),
				`upgrades ${m.upgrades.length - before}`,
			)
		}
		await inst.configUpdated(cfg, { token: TOKEN })
		await waitOpen()

		// 4011 while the token is still valid: check at once and load the state, open the socket only after 30 s.
		{
			const t0 = Date.now()
			const before = m.upgrades.length
			m.closeAll(4011, 'Access revoked')
			await sleep(3000)
			const calls = m.reqs(t0)
			check(
				'4011, token still valid: checked at once, socket waits',
				calls.some((c) => c.startsWith('GET /scenes 200')) &&
					m.upgrades.length === before &&
					status().status === 'connecting',
				`${JSON.stringify(calls)} ${JSON.stringify(statusesSince(t0))}`,
			)
			const back = await waitFor(() => openNow() === 1 && status().status === 'ok', 35000)
			check('4011, token still valid: live again after 30 s', !!back, seconds(t0))
		}

		// 4011 with a revoked token: stop.
		{
			const t0 = Date.now()
			m.plan['GET /scenes'] = Array(50).fill(e401)
			m.plan['GET /screens'] = Array(50).fill(e401)
			m.closeAll(4011, 'Credential revoked')
			await sleep(15000)
			const calls = m.reqs(t0)
			check(
				'4011, token revoked: stops after one check',
				status().status === 'authentication_failure' && calls.length <= 3 && moduleOpen() === 0,
				`${calls.length} calls ${JSON.stringify(calls)}, status ${status().status}:${status().message}`,
			)
		}
		await inst.destroy()
	},

	async config() {
		// Save the config while connected; the old socket only closes 12 s later (1006), as seen on real networks.
		m.closeReplyDelay = 12000
		const inst = await create(cfg)
		await waitOpen()
		const t0 = Date.now()
		await inst.configUpdated(cfg, { token: TOKEN })
		await waitFor(() => sockets.length === 2 && sockets[1].state === 'open', 8000)
		log('new socket open; waiting for the late close of the old one and two ping rounds')
		await waitFor(() => sockets[0].state === 'closed', 30000)
		check(
			'old socket closed late',
			sockets[0].state === 'closed' && sockets[0].closed - t0 > 10000,
			`${((sockets[0].closed - t0) / 1000).toFixed(1)} s, code ${sockets[0].code}`,
		)
		await sleep(Math.max(0, t0 + 70000 - Date.now()))
		const s2 = m.sockets[1]
		check(
			'no third connection after the late close',
			sockets.length === 2 && m.upgrades.length === 2,
			`module sockets ${sockets.length}, upgrades ${m.upgrades.length}`,
		)
		check('pings of the new socket continue', s2.pings >= 2 && !s2.closed, `pings on socket 2: ${s2.pings}`)
		check(
			'status ok with one open socket',
			status().status === 'ok' && moduleOpen() === 1 && m.openCount() === 1,
			`${status().status} module ${moduleOpen()} mock ${m.openCount()}`,
		)
		await inst.destroy()
	},

	async nopong() {
		const inst = await create(cfg)
		await waitOpen()
		const t0 = Date.now()
		m.noPong = true
		const before = m.upgrades.length
		const lost = await waitFor(() => m.upgrades.length > before, 60000)
		const after = (Date.now() - t0) / 1000
		m.noPong = false
		const back = await waitFor(() => openNow() >= 1 && status().status === 'ok', 10000)
		check(
			'ping without pong: socket given up and reconnected',
			!!lost && after > 35 && after < 45 && !!back,
			`${after.toFixed(1)} s, statuses ${JSON.stringify(statusesSince(t0))}`,
		)
		await inst.destroy()
	},

	async freeze() {
		// Half-open TCP: the server neither receives nor sends anything (no close, no pong, no events).
		const inst = await create(cfg)
		await waitOpen()
		const t0 = Date.now()
		m.freezeAll()
		const before = m.upgrades.length
		const lost = await waitFor(() => m.upgrades.length > before, 60000)
		const back = await waitFor(() => openNow() >= 1 && status().status === 'ok', 10000)
		check(
			'frozen line: reconnected within 47 s',
			!!lost && (Date.now() - t0) / 1000 < 47 && !!back,
			`${seconds(t0)}, statuses ${JSON.stringify(statusesSince(t0))}`,
		)
		await inst.destroy()
	},

	async refresh502() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1200)
		m.scenes[0] = { ...m.scenes[0], status: { state: 'live', deviating: [] } }
		m.lastActivated = m.scenes[0].id
		m.plan['GET /scenes'] = [
			{ status: 502, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad gateway</html>' },
		]
		const t0 = Date.now()
		m.broadcast(event('screen_live'))
		await sleep(1000)
		check(
			'502 on refresh: warning, old state kept',
			status().status === 'unknown_warning' && fb('scene_live', { scene: m.scenes[0].id }) === false,
			`${status().status}:${status().message}`,
		)
		const ok = await waitFor(
			() => fb('scene_live', { scene: m.scenes[0].id }) === true && status().status === 'ok',
			8000,
		)
		check('502 on refresh: retried and recovered', !!ok, `${seconds(t0)}, calls ${JSON.stringify(m.reqs(t0))}`)
		await inst.destroy()
	},

	async outoforder() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1200)
		m.delay['GET /scenes'] = [1500, 0]
		const p1 = inst.refresh() // sees the old state, answers after 1.5 s
		await sleep(100)
		m.scenes[0] = { ...m.scenes[0], status: { state: 'live', deviating: [] } }
		m.lastActivated = m.scenes[0].id
		const p2 = inst.refresh() // overlaps: waits for the running refresh, then loads again
		await p2
		check('after the newer refresh: live', fb('scene_live', { scene: m.scenes[0].id }) === true)
		await p1
		await sleep(300)
		check(
			'a slow, older response does not overwrite the newer state',
			fb('scene_live', { scene: m.scenes[0].id }) === true && state.vars.last_scene === 'Scene 1',
			`last_scene ${state.vars.last_scene}`,
		)
		await inst.destroy()
	},

	async html() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1200)
		m.plan['GET /scenes'] = [html]
		m.plan['GET /screens'] = [html]
		m.broadcast(event('scenes'))
		await waitFor(() => status().status !== 'ok', 3000)
		check(
			'HTML with status 200: state kept',
			inst.scenes.length === 3 && inst.screens.length === 2,
			`scenes ${inst.scenes.length} screens ${inst.screens.length}`,
		)
		let threw = ''
		try {
			fb('scene_live', { scene: 'x' })
			fb('screen_online', { target: 'x' })
		} catch (e) {
			threw = String(e)
		}
		check('HTML with status 200: feedbacks keep working', !threw, threw)
		check(
			'HTML with status 200: status mentions the API address',
			status().status === 'connection_failure' && /API address/.test(status().message),
			status().message,
		)
		const ok = await waitFor(() => status().status === 'ok', 8000)
		check('HTML with status 200: recovers by itself', !!ok)
		await inst.destroy()

		// Rejected addresses: http://, no /v1, credentials in the URL.
		for (const apiUrl of [
			m.url.replace('https', 'http'),
			m.url.replace('/v1', ''),
			'https://user:pw@api.screenbird.app/v1',
		]) {
			const before = m.requests.length
			const i2 = await create({ apiUrl })
			await sleep(500)
			check(
				`address rejected: ${apiUrl.replace(/:\d+/, ':PORT')}`,
				status().status === 'bad_config' && m.requests.length === before,
				`${status().status}:${status().message}`,
			)
			await i2.destroy()
		}
	},

	async ratelimit() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1200)
		m.plan[`POST /scenes/${m.scenes[0].id}/activate`] = [
			apiError(429, 'rate_limited', 'Too many requests. Slow down and try again in a minute.', { 'Retry-After': '60' }),
		]
		const r = await press('scene_activate', { scene: m.scenes[0].id })
		check(
			'429 on a press: the action fails visibly, the connection stays ok',
			!r.ok && /Try again in 60 s/.test(r.error) && status().status === 'ok',
			`${r.error} / ${status().status}`,
		)

		// 429 on a refresh: honor Retry-After.
		m.plan['GET /scenes'] = [apiError(429, 'rate_limited', 'Too many requests.', { 'Retry-After': '4' })]
		const t0 = Date.now()
		m.broadcast(event('scenes'))
		await sleep(3000)
		const early = m.reqs(t0).filter((c) => c.startsWith('GET /scenes'))
		check(
			'429 on refresh: waits for Retry-After (4 s)',
			early.length === 1 && timers.some((x) => x.at >= t0 && x.ms === 4000),
			JSON.stringify(early),
		)
		const ok = await waitFor(
			() => m.reqs(t0).filter((c) => c === 'GET /scenes 200').length === 1 && status().status === 'ok',
			5000,
		)
		check('429 on refresh: recovers afterwards', !!ok, seconds(t0))
		await inst.destroy()
	},

	async revoked() {
		// 401 on a refresh while the socket is open.
		{
			const inst = await create(cfg)
			await waitOpen()
			await sleep(1200)
			m.plan['GET /scenes'] = Array(50).fill(e401)
			m.plan['GET /screens'] = Array(50).fill(e401)
			const t0 = Date.now()
			m.broadcast(event('scenes'))
			await sleep(40000)
			const calls = m.reqs(t0)
			check(
				'401 with open socket: stopped, socket closed, no further attempts',
				status().status === 'authentication_failure' && moduleOpen() === 0 && calls.length <= 2,
				`${calls.length} calls, status ${status().status}`,
			)
			const r = await press('scene_activate', { scene: m.scenes[0].id })
			check('press after stop: fails visibly without a request', !r.ok && m.reqs(t0).length === calls.length, r.error)
			await inst.destroy()
		}

		// The connection drops and the token was revoked meanwhile: no retry every 30 s.
		{
			m.plan = {}
			const inst = await create(cfg)
			await waitOpen(1)
			await sleep(1200)
			m.plan['GET /scenes'] = Array(50).fill(e401)
			m.plan['GET /screens'] = Array(50).fill(e401)
			m.upgradePlan = Array(10).fill({ status: 401 })
			const t0 = Date.now()
			m.sockets.forEach((s) => s.sock.destroy())
			await sleep(45000)
			const calls = m.reqs(t0)
			check(
				'dropped and revoked: stops after one check',
				status().status === 'authentication_failure' && calls.length <= 2,
				`${calls.length} calls ${JSON.stringify(calls)}`,
			)
			await inst.destroy()
		}
	},

	async forbidden() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1200)
		m.plan[`POST /scenes/${m.scenes[0].id}/activate`] = [
			apiError(403, 'no_permission', 'The person who created this token does not have permission for this action.'),
		]
		const r = await press('scene_activate', { scene: m.scenes[0].id })
		await sleep(500)
		check(
			'403 on one press: the press fails, the connection stays ok',
			!r.ok && status().status === 'ok',
			`${r.error} / ${status().status}`,
		)
		await inst.destroy()
	},

	async inactive() {
		const e = apiError(403, 'account_inactive', 'The Screenbird account has no active subscription.')
		m.plan['GET /scenes'] = Array(10).fill(e)
		m.plan['GET /screens'] = Array(10).fill(e)
		const t0 = Date.now()
		const inst = await create(cfg)
		await sleep(15000)
		const calls = m.reqs(t0)
		check(
			'account inactive at start: waits 5 minutes, no quick retries',
			status().status === 'connection_failure' && calls.length <= 2 && timers.some((x) => x.ms === 300000),
			`${calls.length} calls, ${status().status}:${status().message}`,
		)
		// Account active again: a press works and the module goes live at once, not after the 5 minutes.
		m.plan = {}
		const r = await press('scene_activate', { scene: m.scenes[0].id })
		const live = await waitOpen(1, 4000)
		check(
			'account active again: press works and goes live at once',
			r.ok && !!live,
			`${r.error ?? 'ok'} / ${status().status}`,
		)
		await inst.destroy()
	},

	async scenesoff() {
		for (const code of ['no_permission', 'scenes_disabled']) {
			m.plan['GET /scenes'] = Array(20).fill(apiError(403, code, `scenes: ${code}`))
			const inst = await create(cfg)
			const ok = await waitOpen()
			check(
				`/scenes ${code}: screens only, status ok`,
				!!ok && inst.scenes.length === 0 && inst.screens.length === 2,
				`${status().status}:${status().message}`,
			)
			await inst.destroy()
			await sleep(200)
			m.plan = {}
		}
	},

	async content403() {
		m.plan['GET /content'] = Array(5).fill(
			apiError(403, 'insufficient_scope', 'The API token does not have the scope this call needs.'),
		)
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1500)
		check(
			'content without scope: connection ok, empty list, one log message',
			status().status === 'ok' &&
				state.actions.push.options[1].choices.length === 0 &&
				state.logs.filter((l) => /content:read/.test(l.message)).length === 1,
		)
		const r = await press('push', { target: m.screens[0].id, content: '', minutes: 0 })
		check('push without content: fails visibly', !r.ok, r.error)
		await inst.destroy()
	},

	async destroy() {
		m.delay['GET /scenes'] = [1500]
		const inst = await create(cfg)
		await sleep(200)
		const n = state.statuses.length
		await inst.destroy()
		await sleep(3000)
		check(
			'destroy during the first refresh: no socket, no further status',
			sockets.length === 0 && m.upgrades.length === 0 && state.statuses.length === n,
			`sockets ${sockets.length}, statuses after ${state.statuses.length - n}`,
		)
	},

	async cleanup() {
		const activeTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
		const base = activeTimeouts()
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1500)
		log('timers while connected:', activeTimeouts() - base)
		await inst.destroy()
		await sleep(1500)
		check('no module timers left after destroy', activeTimeouts() - base <= 0, `${activeTimeouts() - base} left`)
	},

	async apiurl() {
		// The config field regex must accept exactly what parseApiUrl() accepts.
		const { GetConfigFields } = await import(pathToFileURL(`${MODULE_DIR}/dist/config.js`).href)
		const { parseApiUrl } = await import(pathToFileURL(`${MODULE_DIR}/dist/api.js`).href)
		const source = GetConfigFields().find((f) => f.id === 'apiUrl').regex
		const re = new RegExp(source.slice(1, source.lastIndexOf('/')))
		const cases = [
			['', true],
			['https://api.screenbird.app/v1', true],
			['https://api.screenbird.app/v1/', true],
			['https://example.com/api/v1', true],
			['http://api.screenbird.app/v1', false],
			['https://api.screenbird.app', false],
			['https://api.screenbird.app/v1?x=1', false],
			['https://u:p@api.screenbird.app/v1', false],
			['wss://api.screenbird.app/v1', false],
		]
		for (const [url, valid] of cases) {
			check(
				`address "${url}" ${valid ? 'accepted' : 'rejected'} by regex and parser`,
				re.test(url) === valid && (parseApiUrl(url) !== null) === valid,
				`regex ${re.test(url)}, parser ${parseApiUrl(url)}`,
			)
		}
	},

	async burst() {
		const inst = await create(cfg)
		await waitOpen()
		await sleep(1500)
		const t0 = Date.now()
		for (let i = 0; i < 20; i++) {
			m.broadcast(event('scene_targets'))
			await sleep(100)
		}
		await sleep(1500)
		const refreshes = m.reqs(t0).filter((c) => c.startsWith('GET /scenes'))
		check('20 events in 2 s: refreshes stay spaced (at most 4)', refreshes.length <= 4, `${refreshes.length} refreshes`)
		await inst.destroy()
	},

	async nextscene() {
		const inst = await create(cfg)
		await waitOpen()
		const cases = [
			[null, 'Scene 1'],
			[m.scenes[0].id, 'Scene 2'],
			[m.scenes[2].id, 'Scene 1'],
			['99999999-0000-4000-8000-000000000000', 'Scene 1'],
		]
		for (const [last, want] of cases) {
			m.lastActivated = last
			await inst.refresh()
			const name = last ? (m.scenes.find((s) => s.id === last)?.name ?? 'a deleted scene') : 'none'
			check(`next_scene after ${name}`, state.vars.next_scene === want, state.vars.next_scene)
		}
		await inst.destroy()
	},

	async handshake() {
		m.upgradePlan = [{ status: 503 }, { status: 503 }]
		const t0 = Date.now()
		const inst = await create(cfg)
		await sleep(500)
		check('refused socket: status not ok', status().status !== 'ok', `${status().status}:${status().message}`)
		const ok = await waitOpen(1, 15000)
		check(
			'socket refused twice: live after backoff',
			!!ok && m.upgrades.length === 3,
			`${seconds(t0)}, upgrades ${m.upgrades.length}, statuses ${JSON.stringify(statusesSince(t0))}`,
		)
		await inst.destroy()
	},
}

if (!scenarios[which]) {
	console.error(`Unknown scenario "${which}". Available: ${Object.keys(scenarios).join(', ')}`)
	await m.stop()
	process.exitCode = 2
} else {
	await scenarios[which]()
	await sleep(200)
	await m.stop().catch(() => {})
	log(`${which}: ${passed()} passed, ${failed()} failed`)
	process.exitCode = failed() === 0 ? 0 : 1
}
