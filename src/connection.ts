import { InstanceStatus, type LogLevel } from '@companion-module/base'
import {
	ApiError,
	describeError,
	type ScreenbirdApi,
	type ContentItem,
	type Scene,
	type ScenesResult,
	type Screen,
} from './api.js'
import { classifyError, SLOW_RETRY_MS, type Failure, type Outcome } from './failures.js'
import { LiveSocket } from './live-socket.js'

const STABLE_SOCKET_MS = 30_000 // a socket that stayed open this long resets the reconnect backoff
const RECONNECT_START_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RECONNECT_JITTER_MS = 500
const SOCKET_HOLD_MS = 30_000 // after close code 4008 or 4011: wait this long before opening a new socket

const REFRESH_DEBOUNCE_MS = 250
// A refresh costs two GETs (/scenes and /screens). One refresh per 2 s at most keeps even a burst of events at 60
// requests per minute, well below the API limit of 120 per minute per token.
const REFRESH_SPACING_MS = 2_000
const REFRESH_RETRY_START_MS = 2_000
const REFRESH_RETRY_MAX_MS = 60_000

// The content list has no live events: it is reloaded along with a refresh, at most once a minute, or sooner when a
// push action is added.
const CONTENT_MAX_AGE_MS = 60_000
const CONTENT_ON_DEMAND_MAX_AGE_MS = 10_000

/** Close codes of the events socket that need more than a plain reconnect. */
const CLOSE_ACCESS_ENDED = 4011 // token revoked, account inactive, or the token's creator lost access
const CLOSE_REPLACED = 4008 // another socket with the same token took over

/** 403 codes on GET /scenes that only mean "no scenes": the module keeps working with screens. */
const SCENES_UNAVAILABLE_CODES = new Set(['scenes_disabled', 'no_permission', 'insufficient_scope'])

export interface ConnectionState {
	scenes: Scene[]
	lastActivated: string | null
	screens: Screen[]
}

/** What the connection reports back to the module instance. */
export interface ConnectionHost {
	log(level: LogLevel, message: string): void
	setStatus(status: InstanceStatus, message?: string): void
	stateLoaded(state: ConnectionState): void
	contentLoaded(items: ContentItem[]): void
	/** The connection stopped for good; it does not retry until the config is saved again. */
	halted(status: InstanceStatus, message: string): void
}

/** Exponential backoff that doubles after every use up to `max`, with optional random jitter on top. */
class Backoff {
	private current: number

	constructor(
		private readonly start: number,
		private readonly max: number,
		private readonly jitter = 0,
	) {
		this.current = start
	}

	next(): number {
		const wait = this.current + Math.floor(Math.random() * this.jitter)
		this.current = Math.min(this.current * 2, this.max)
		return wait
	}

	reset(): void {
		this.current = this.start
	}
}

/**
 * The connection to Screenbird for one set of credentials. It loads scenes and screens over REST, then keeps them
 * current through the live socket (/v1/events): every change arrives as an event, after which the small scene and
 * screen lists are loaded again. There is no polling.
 *
 * The module creates a new Connection on every start (init, config saved) and stops the previous one. A stopped
 * connection ignores its own late timers, sockets and responses, so they can never undo newer state.
 */
export class Connection {
	private stopped = false
	private stateLoaded = false
	private problem: { status: InstanceStatus; message: string } | null = null
	private socket: LiveSocket | null = null
	private socketHoldUntil = 0
	private readonly reconnectBackoff = new Backoff(RECONNECT_START_MS, RECONNECT_MAX_MS, RECONNECT_JITTER_MS)
	private cycleTimer: NodeJS.Timeout | null = null

	private refreshTimer: NodeJS.Timeout | null = null
	private refreshing: Promise<Outcome> | null = null
	private refreshAgain = false
	private lastRefreshAt = 0
	private readonly refreshBackoff = new Backoff(REFRESH_RETRY_START_MS, REFRESH_RETRY_MAX_MS)
	private scenesUnavailableReason = ''

	private contentLoading = false
	private contentLoadedAt = 0
	private contentDenied = false

	constructor(
		private readonly client: ScreenbirdApi,
		private readonly host: ConnectionHost,
	) {}

	/** The API client, or null once the connection has stopped. */
	get api(): ScreenbirdApi | null {
		return this.stopped ? null : this.client
	}

	isLive(): boolean {
		return this.socket?.isOpen === true
	}

	start(): void {
		this.host.setStatus(InstanceStatus.Connecting)
		this.scheduleCycle(0)
	}

	stop(): void {
		this.stopped = true
		if (this.cycleTimer) clearTimeout(this.cycleTimer)
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.cycleTimer = this.refreshTimer = null
		this.dropSocket()
		this.refreshing = null
		this.refreshAgain = false
		this.contentLoading = false
	}

	/** An action failed with this error. Only a refused token affects the connection; other errors only fail the press. */
	actionFailed(e: unknown): void {
		if (this.stopped || !(e instanceof ApiError) || e.status !== 401) return
		this.fail(classifyError(e, this.isLive()))
	}

	// ---- connect cycle: load the state, then open the live socket ----

	private scheduleCycle(delay: number): void {
		if (this.stopped) return
		if (this.cycleTimer) clearTimeout(this.cycleTimer)
		this.cycleTimer = setTimeout(
			() => {
				this.cycleTimer = null
				this.background(this.cycle())
			},
			Math.max(0, delay),
		)
	}

	private async cycle(): Promise<void> {
		if (this.stopped || this.socket) return
		const outcome = await this.refresh()
		if (this.stopped || outcome.kind === 'stale') return
		if (outcome.kind !== 'ok') {
			this.fail(outcome)
			return
		}
		this.loadContent(false)
		const hold = this.socketHoldUntil - Date.now()
		if (hold <= 0) {
			this.openSocket()
			return
		}
		this.cycleTimer = setTimeout(() => {
			this.cycleTimer = null
			this.openSocket()
		}, hold)
	}

	/** Act on a failure: halt, check again slowly, or retry (only the refresh while the socket is open). */
	private fail(failure: Failure): void {
		if (this.stopped) return
		if (failure.kind === 'halt') {
			this.stop()
			this.host.halted(failure.status, failure.message)
			return
		}
		if (this.problem?.message !== failure.message) this.host.log('warn', failure.message)
		this.problem = { status: failure.status, message: failure.message }
		if (failure.kind === 'slow') {
			this.dropSocket()
			this.scheduleCycle(SLOW_RETRY_MS)
		} else if (this.socket) {
			this.scheduleRefresh(failure.retryAfterMs ?? this.refreshBackoff.next(), true)
		} else if (!this.cycleTimer || failure.retryAfterMs) {
			this.scheduleCycle(failure.retryAfterMs ?? this.reconnectBackoff.next())
		}
		this.showStatus()
	}

	/** Ok needs both the loaded state and an open live socket; otherwise show the problem or the reconnect. */
	private showStatus(): void {
		if (this.stopped) return
		if (this.problem) this.host.setStatus(this.problem.status, this.problem.message)
		else if (!this.stateLoaded) this.host.setStatus(InstanceStatus.Connecting)
		else if (!this.isLive()) this.host.setStatus(InstanceStatus.Connecting, 'Waiting for the live connection')
		else this.host.setStatus(InstanceStatus.Ok)
	}

	// ---- state ----

	/**
	 * Load scenes and screens. Runs one at a time: a call during a running refresh waits for it and makes it run once
	 * more, so an older, slower response can never overwrite a newer one.
	 */
	async refresh(): Promise<Outcome> {
		if (this.refreshing) {
			this.refreshAgain = true
			return this.refreshing
		}
		const run = this.runRefresh().finally(() => {
			if (this.refreshing === run) this.refreshing = null
		})
		this.refreshing = run
		return run
	}

	/** Refresh after an event, debounced and spaced at least REFRESH_SPACING_MS apart. */
	requestRefresh(delay = REFRESH_DEBOUNCE_MS): void {
		this.scheduleRefresh(delay, false)
	}

	private async runRefresh(): Promise<Outcome> {
		let outcome: Outcome
		do {
			this.refreshAgain = false
			outcome = await this.loadState()
		} while (outcome.kind === 'ok' && this.refreshAgain && !this.stopped)
		return outcome
	}

	private async loadState(): Promise<Outcome> {
		if (this.stopped) return { kind: 'stale' }
		this.lastRefreshAt = Date.now()
		try {
			const [scenes, screens] = await Promise.all([this.loadScenes(), this.client.screens()])
			if (this.stopped) return { kind: 'stale' }
			this.stateLoaded = true
			this.problem = null
			this.host.stateLoaded({ scenes: scenes.scenes, lastActivated: scenes.lastActivated, screens })
			this.showStatus()
			return { kind: 'ok' }
		} catch (e) {
			if (this.stopped) return { kind: 'stale' }
			return classifyError(e, this.isLive())
		}
	}

	/** Scenes can be turned off for an account, or hidden from the token: the module then works with screens only. */
	private async loadScenes(): Promise<ScenesResult> {
		try {
			const result = await this.client.scenes()
			this.noteScenesUnavailable('')
			return result
		} catch (e) {
			if (e instanceof ApiError && e.status === 403 && SCENES_UNAVAILABLE_CODES.has(e.code)) {
				this.noteScenesUnavailable(e.message)
				return { scenes: [], lastActivated: null }
			}
			throw e
		}
	}

	private noteScenesUnavailable(reason: string): void {
		if (reason === this.scenesUnavailableReason) return
		this.scenesUnavailableReason = reason
		if (reason) this.host.log('info', `Scenes are not available, the module works with screens only: ${reason}`)
	}

	private scheduleRefresh(delay: number, replace: boolean): void {
		if (this.stopped) return
		if (this.refreshTimer) {
			if (!replace) return
			clearTimeout(this.refreshTimer)
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null
			this.background(this.scheduledRefresh())
		}, delay)
	}

	private async scheduledRefresh(): Promise<void> {
		if (this.stopped) return
		const wait = this.lastRefreshAt + REFRESH_SPACING_MS - Date.now()
		if (wait > 0) {
			this.scheduleRefresh(wait, false)
			return
		}
		const outcome = await this.refresh()
		if (this.stopped || outcome.kind === 'stale') return
		if (outcome.kind !== 'ok') {
			this.fail(outcome)
			return
		}
		this.refreshBackoff.reset()
		this.loadContent(false)
		// Screenbird answers again while the socket is down (for example a button press during a retry wait):
		// connect now instead of waiting for the retry.
		if (!this.socket && Date.now() >= this.socketHoldUntil) {
			if (this.cycleTimer) clearTimeout(this.cycleTimer)
			this.cycleTimer = null
			this.openSocket()
		}
	}

	/**
	 * Load the content list for "Screen: push content" when it is older than its maximum age. Never fails the
	 * connection: a token without content:read simply has no list.
	 */
	loadContent(onDemand: boolean): void {
		if (this.stopped || this.contentDenied || this.contentLoading) return
		const maxAge = onDemand ? CONTENT_ON_DEMAND_MAX_AGE_MS : CONTENT_MAX_AGE_MS
		if (Date.now() - this.contentLoadedAt < maxAge) return
		this.contentLoading = true
		this.background(this.fetchContent())
	}

	private async fetchContent(): Promise<void> {
		try {
			const items = await this.client.content()
			if (this.stopped) return
			this.host.contentLoaded(items)
		} catch (e) {
			if (this.stopped) return
			if (e instanceof ApiError && e.status === 403) {
				this.contentDenied = true
				this.host.log(
					'warn',
					'The API token cannot list content (content:read), so "Screen: push content" has no content to choose from.',
				)
			} else {
				this.host.log('warn', `Could not load the content list: ${describeError(e)}`)
			}
		} finally {
			if (!this.stopped) {
				this.contentLoading = false
				this.contentLoadedAt = Date.now()
			}
		}
	}

	/** Work started by a timer or socket event: an unexpected error is logged instead of becoming an unhandled rejection. */
	private background(work: Promise<unknown>): void {
		work.catch((e: unknown) => this.host.log('error', `Unexpected error: ${describeError(e)}`))
	}

	// ---- live socket ----

	private openSocket(): void {
		if (this.stopped || this.socket) return
		let ws: WebSocket
		try {
			ws = this.client.openEvents()
		} catch (e) {
			this.host.log('warn', `Live updates could not start: ${describeError(e)}`)
			this.scheduleCycle(this.reconnectBackoff.next())
			return
		}
		this.socket = new LiveSocket(ws, {
			open: () => {
				this.host.log('info', 'Live updates connected')
				// Changes between the last load and this moment did not produce an event: load once more.
				this.requestRefresh(0)
				this.showStatus()
			},
			change: () => this.requestRefresh(),
			lost: (code, reason, openedAt) => {
				this.socket = null
				this.socketLost(code, reason, openedAt)
			},
			warn: (message) => this.host.log('warn', message),
		})
	}

	/** Close the current socket on purpose (stop, slow retry). */
	private dropSocket(): void {
		this.socket?.close()
		this.socket = null
	}

	private socketLost(code: number, reason: string, openedAt: number): void {
		if (this.stopped) return
		if (openedAt > 0 && Date.now() - openedAt >= STABLE_SOCKET_MS) this.reconnectBackoff.reset()
		if (code === CLOSE_ACCESS_ENDED) {
			// Find out right away why access ended: a revoked token halts on the 401, an inactive account or missing
			// permission is checked again slowly, anything else reconnects after the hold.
			this.host.log('warn', 'Screenbird ended the live connection: access for this API token ended')
			this.problem = {
				status: InstanceStatus.AuthenticationFailure,
				message: 'Screenbird ended access for this API token. Checking why.',
			}
			this.socketHoldUntil = Date.now() + SOCKET_HOLD_MS
			this.scheduleCycle(0)
		} else if (code === CLOSE_REPLACED) {
			this.host.log(
				'warn',
				'Another live connection with this API token took over. Use one token per Companion connection.',
			)
			this.socketHoldUntil = Date.now() + SOCKET_HOLD_MS
			this.scheduleCycle(SOCKET_HOLD_MS)
		} else {
			if (code) this.host.log('info', `Live updates closed (${code}${reason ? ` ${reason}` : ''}), reconnecting`)
			this.scheduleCycle(this.reconnectBackoff.next())
		}
		this.showStatus()
	}
}
