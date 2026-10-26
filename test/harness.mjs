// Test harness: loads the packaged module (pkg/screenbird-signage/main.js, the file Companion loads) with a fake
// instance context that matches @companion-module/base 2.0, and records statuses, variables, definitions, sockets and
// scheduled timers so scenarios can assert on them.
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MODULE_DIR = process.env.MODULE_DIR || fileURLToPath(new URL('..', import.meta.url))
const PKG = `${MODULE_DIR}/pkg/screenbird-signage/main.js`
const T0 = Date.now()
export const t = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6)
export const log = (...a) => console.log(`[${t()}]`, ...a)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- scheduled timers (to see a 5 minute or Retry-After wait without waiting for it) ----
export const timers = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (fn, ms, ...rest) {
	if (typeof ms === 'number' && ms >= 1500) timers.push({ at: Date.now(), ms })
	return realSetTimeout(fn, ms, ...rest)
}

// ---- the module's WebSockets ----
export const sockets = []
const RealWS = globalThis.WebSocket
class TrackedWS extends RealWS {
	constructor(url, init) {
		super(url, init)
		const rec = {
			n: sockets.length + 1,
			url: String(url),
			state: 'connecting',
			opened: null,
			closed: null,
			code: null,
			sent: 0,
		}
		sockets.push(rec)
		this._rec = rec
		this.addEventListener('open', () => {
			rec.state = 'open'
			rec.opened = Date.now()
			log(`WS#${rec.n} open`)
		})
		this.addEventListener('close', (ev) => {
			rec.state = 'closed'
			rec.closed = Date.now()
			rec.code = ev.code
			log(`WS#${rec.n} close code=${ev.code}${ev.reason ? ' reason=' + ev.reason : ''}`)
		})
	}
	send(d) {
		this._rec.sent++
		return super.send(d)
	}
	close(...a) {
		log(`WS#${this._rec.n} close() by the module (readyState ${this.readyState})`)
		return super.close(...a)
	}
}
globalThis.WebSocket = TrackedWS
export const moduleOpen = () => sockets.filter((s) => s.state !== 'closed').length

// ---- fake Companion host ----
export const state = {
	statuses: [],
	vars: {},
	actions: null,
	feedbacks: null,
	presets: null,
	structure: null,
	defs: { actions: 0, feedbacks: 0, presets: 0 },
	logs: [],
}
globalThis.COMPANION_LOGGER = (source, level, message) => {
	state.logs.push({ at: Date.now(), level, message })
	if (level !== 'debug') log(`log.${level}:`, message)
}
export const ctx = {
	_isInstanceContext: true,
	id: 'test-1',
	label: 'screenbird',
	upgradeScripts: [],
	saveConfig() {},
	updateStatus(status, message) {
		log('STATUS', status, message ?? '')
		state.statuses.push({ at: Date.now(), status, message })
	},
	oscSend() {},
	recordAction() {},
	setActionDefinitions(a) {
		state.actions = a
		state.defs.actions++
	},
	subscribeActions() {},
	unsubscribeActions() {},
	setFeedbackDefinitions(f) {
		state.feedbacks = f
		state.defs.feedbacks++
	},
	unsubscribeFeedbacks() {},
	checkFeedbacks() {},
	checkAllFeedbacks() {},
	checkFeedbacksById() {},
	setPresetDefinitions(s, p) {
		state.structure = s
		state.presets = p
		state.defs.presets++
	},
	setVariableDefinitions(v) {
		state.varDefs = v
	},
	setVariableValues(v) {
		Object.assign(state.vars, v)
	},
	getVariableValue(id) {
		return state.vars[id]
	},
	sharedUdpSocketHandlers: new Map(),
	sharedUdpSocketJoin: async () => '',
	sharedUdpSocketLeave: async () => {},
	sharedUdpSocketSend: async () => {},
}
export const status = () => state.statuses[state.statuses.length - 1] || {}
export const TOKEN = 'sbk_' + 'x'.repeat(43)

export async function create(config, secrets = { token: TOKEN }) {
	const mod = await import(pathToFileURL(PKG).href)
	const inst = new mod.default(ctx)
	await inst.init(config, true, secrets)
	return inst
}

/** Runs an action like Companion does: a thrown error means a failed action ("Error executing action"). */
export async function press(actionId, options = {}) {
	const def = state.actions?.[actionId]
	if (!def) throw new Error('no action ' + actionId)
	try {
		await def.callback({ id: 'a1', actionId, controlId: 'bank:1', options, surfaceId: undefined }, {})
		return { ok: true }
	} catch (e) {
		return { ok: false, error: e?.message ?? String(e) }
	}
}

export function fb(feedbackId, options) {
	const def = state.feedbacks?.[feedbackId]
	if (!def) throw new Error('no feedback ' + feedbackId)
	return def.callback({ id: 'f1', feedbackId, controlId: 'bank:1', options, type: 'boolean' }, {})
}

export async function waitFor(fn, ms, step = 50) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		try {
			const v = fn()
			if (v) return v
		} catch {
			// Not ready yet; poll again.
		}
		await sleep(step)
	}
	return null
}

let passes = 0
let failures = 0
export function check(name, ok, detail = '') {
	if (ok) passes++
	else failures++
	log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
export const failed = () => failures
export const passed = () => passes
