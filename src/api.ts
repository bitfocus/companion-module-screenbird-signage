// Client for the Screenbird API v1: REST calls plus the live WebSocket (/v1/events).
// Node 22 ships fetch and WebSocket (undici), so the module needs no HTTP or WebSocket dependency.

export const DEFAULT_API_URL = 'https://api.screenbird.app/v1'
/** API tokens: `sbk_` or `sbo_` followed by 43 base64url characters. */
export const TOKEN_RE = /^sb[ko]_[A-Za-z0-9_-]{43}$/

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRY_AFTER_MS = 10 * 60_000
const INVALID_RESPONSE_MESSAGE = 'The API address does not answer like the Screenbird API. Check the API address.'

export type SceneState = 'live' | 'stale' | 'partial' | 'off' | 'empty'
export type LiveKind = 'normal' | 'push' | 'scene' | 'mirror'

export interface Scene {
	id: string
	name: string
	color: string
	state: SceneState
}

export interface Subscreen {
	id: string
	name: string
	live: LiveKind
}

export interface Screen {
	id: string
	name: string
	online: boolean
	live: LiveKind
	subscreens: Subscreen[]
}

export interface ContentItem {
	id: string
	name: string
	type: string
}

export interface ScenesResult {
	scenes: Scene[]
	lastActivated: string | null
}

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		/** From the Retry-After header of a 429, in milliseconds. */
		public retryAfterMs: number | null = null,
	) {
		super(message)
	}
}

/**
 * Validates the API address from the config: https only, so the token never travels unencrypted, and ending in /v1,
 * like https://api.screenbird.app/v1. Empty means the default. Returns the normalized address, or null when unusable.
 */
export function parseApiUrl(raw: string | undefined): string | null {
	const text = (raw ?? '').trim() || DEFAULT_API_URL
	let url: URL
	try {
		url = new URL(text)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
	const path = url.pathname.replace(/\/+$/, '')
	if (!path.endsWith('/v1')) return null
	return url.origin + path
}

/** A readable reason for any error, for logs and failed actions. */
export function describeError(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 429 && e.retryAfterMs) return `${e.message} Try again in ${Math.ceil(e.retryAfterMs / 1000)} s.`
		return e.message
	}
	return e instanceof Error ? e.message : String(e)
}

const SCENE_STATES: readonly string[] = ['live', 'stale', 'partial', 'off', 'empty']
const LIVE_KINDS: readonly string[] = ['normal', 'push', 'scene', 'mirror']

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function text(v: unknown): string {
	return typeof v === 'string' ? v : ''
}

function liveKind(v: unknown): LiveKind {
	const kind = text(record(v)?.kind)
	return LIVE_KINDS.includes(kind) ? (kind as LiveKind) : 'normal'
}

/**
 * The list under `key`. Throws when the body is not what the Screenbird API sends (for example a captive portal or a
 * wrong address), so the last known state is kept instead of being replaced by an empty list.
 */
function listOf(body: unknown, key: string): unknown[] {
	const list = record(body)?.[key]
	if (!Array.isArray(list)) throw new ApiError(200, 'invalid_response', INVALID_RESPONSE_MESSAGE)
	return list
}

/** Retry-After as seconds or an HTTP date, clamped to 1 s .. 10 min so a bad header cannot stall the module. */
function retryAfterMs(header: string | null): number | null {
	if (!header) return null
	const seconds = Number(header)
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
	if (!Number.isFinite(ms)) return null
	return Math.min(Math.max(ms, 1000), MAX_RETRY_AFTER_MS)
}

function networkReason(e: unknown): string {
	if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
		return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`
	const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
	if (typeof cause?.code === 'string') return cause.code
	if (typeof cause?.message === 'string') return cause.message
	return e instanceof Error ? e.message : String(e)
}

export class ScreenbirdApi {
	constructor(
		private baseUrl: string,
		private token: string,
		private version: string,
	) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			'X-Screenbird-Client': 'companion',
			'User-Agent': `screenbird-companion/${this.version}`,
			Accept: 'application/json',
		}
	}

	/**
	 * One API call. Every failure becomes an ApiError: status 0 when Screenbird was not reached, code
	 * `invalid_response` when the answer is not API JSON.
	 */
	async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
		const headers = this.headers()
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		let res: Response
		let raw: string
		try {
			res = await fetch(this.baseUrl + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
			raw = await res.text()
		} catch (e) {
			throw new ApiError(0, 'unreachable', `Cannot reach Screenbird (${networkReason(e)}).`)
		}
		const isJson = /^application\/([\w.+-]+\+)?json\b/i.test(res.headers.get('content-type') ?? '')
		let json: unknown = undefined
		if (isJson && raw) {
			try {
				json = JSON.parse(raw)
			} catch {
				json = undefined
			}
		}
		if (!res.ok) {
			const err = record(record(json)?.error)
			throw new ApiError(
				res.status,
				text(err?.code) || `http_${res.status}`,
				text(err?.message) || `Screenbird answered HTTP ${res.status}.`,
				retryAfterMs(res.headers.get('retry-after')),
			)
		}
		if (json === undefined) {
			throw new ApiError(res.status, 'invalid_response', INVALID_RESPONSE_MESSAGE)
		}
		return json
	}

	async screens(): Promise<Screen[]> {
		const out: Screen[] = []
		for (const item of listOf(await this.request('GET', '/screens'), 'screens')) {
			const s = record(item)
			if (!s || typeof s.id !== 'string') continue
			const subscreens: Subscreen[] = []
			for (const zone of Array.isArray(s.subscreens) ? s.subscreens : []) {
				const z = record(zone)
				if (z && typeof z.id === 'string')
					subscreens.push({ id: z.id, name: text(z.name) || 'Sub-screen', live: liveKind(z.live) })
			}
			out.push({
				id: s.id,
				name: text(s.name) || 'Screen',
				online: s.online === true,
				live: liveKind(s.live),
				subscreens,
			})
		}
		return out
	}

	/** Scenes in the order of the Scenes page (the API sorts them), plus the scene that was activated last. */
	async scenes(): Promise<ScenesResult> {
		const body = await this.request('GET', '/scenes')
		const scenes: Scene[] = []
		for (const item of listOf(body, 'scenes')) {
			const s = record(item)
			if (!s || typeof s.id !== 'string') continue
			const state = text(record(s.status)?.state)
			scenes.push({
				id: s.id,
				name: text(s.name) || 'Scene',
				color: text(s.color),
				state: SCENE_STATES.includes(state) ? (state as SceneState) : 'off',
			})
		}
		const last = record(body)?.last_activated
		return { scenes, lastActivated: typeof last === 'string' ? last : null }
	}

	/** Content to push, newest first. */
	async content(): Promise<ContentItem[]> {
		const out: ContentItem[] = []
		for (const item of listOf(await this.request('GET', '/content?limit=500'), 'items')) {
			const c = record(item)
			if (c && typeof c.id === 'string') out.push({ id: c.id, name: text(c.name) || 'Untitled', type: text(c.type) })
		}
		return out
	}

	async activate(sceneId: string): Promise<unknown> {
		return this.request('POST', `/scenes/${encodeURIComponent(sceneId)}/activate`, {})
	}

	async release(sceneId: string): Promise<unknown> {
		return this.request('POST', `/scenes/${encodeURIComponent(sceneId)}/release`, {})
	}

	async releaseAll(): Promise<unknown> {
		return this.request('POST', '/scenes/release-all', {})
	}

	async next(): Promise<unknown> {
		return this.request('POST', '/scenes/next', {})
	}

	async push(screenId: string, subscreenId: string | null, contentId: string, until: string | null): Promise<unknown> {
		const body: Record<string, unknown> = { content_id: contentId }
		if (subscreenId) body.subscreen_id = subscreenId
		if (until) body.until = until
		return this.request('POST', `/screens/${encodeURIComponent(screenId)}/push`, body)
	}

	async releaseScreen(screenId: string, subscreenId: string | null): Promise<unknown> {
		return this.request(
			'POST',
			`/screens/${encodeURIComponent(screenId)}/release`,
			subscreenId ? { subscreen_id: subscreenId } : {},
		)
	}

	eventsUrl(): string {
		return this.baseUrl.replace(/^https:/, 'wss:') + '/events'
	}

	/** Opens the live socket. The token goes in a header: undici, the WebSocket of Node, accepts headers as a non-standard option. */
	openEvents(): WebSocket {
		return new WebSocket(this.eventsUrl(), { headers: this.headers() })
	}
}
