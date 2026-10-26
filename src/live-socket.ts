const PING_MESSAGE = JSON.stringify({ type: 'ping' }) // the server answers this exact text without waking up
const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 15_000

export interface LiveSocketEvents {
	/** The socket opened. */
	open(): void
	/** The server reported a change to scenes or screens, or asked for a full reload. */
	change(): void
	/** The socket closed or was given up. `code` is 0 when the module gave up on it. */
	lost(code: number, reason: string, openedAt: number): void
	warn(message: string): void
}

/**
 * One WebSocket to /v1/events with its own handshake timeout and keepalive. Once it is lost or closed on purpose,
 * none of its callbacks fire again, so a late close event of an old socket can never affect a newer one.
 */
export class LiveSocket {
	private openedAt = 0
	private active = true
	private handshakeTimer: NodeJS.Timeout | null
	private pingTimer: NodeJS.Timeout | null = null
	private pongTimer: NodeJS.Timeout | null = null

	constructor(
		private readonly ws: WebSocket,
		private readonly events: LiveSocketEvents,
	) {
		this.handshakeTimer = setTimeout(
			() => this.abandon('The live connection did not open in time'),
			HANDSHAKE_TIMEOUT_MS,
		)
		ws.addEventListener('open', () => this.handleOpen())
		ws.addEventListener('message', (event) => this.handleMessage(event.data))
		ws.addEventListener('close', (event) => this.handleClose(event.code, event.reason))
		ws.addEventListener('error', () => this.handleError())
	}

	get isOpen(): boolean {
		return this.active && this.openedAt > 0
	}

	/** Close on purpose. No `lost` callback follows. */
	close(): void {
		if (!this.active) return
		this.release()
		try {
			this.ws.close(1000)
		} catch {
			// already closed
		}
	}

	private handleOpen(): void {
		if (!this.active) return
		this.clearHandshakeTimer()
		this.openedAt = Date.now()
		this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
		this.events.open()
	}

	private handleMessage(data: unknown): void {
		if (!this.active) return
		// Any message proves the line works, not only a pong.
		if (this.pongTimer) clearTimeout(this.pongTimer)
		this.pongTimer = null
		let message: { type?: unknown } | null
		try {
			message = JSON.parse(String(data)) as { type?: unknown } | null
		} catch {
			return
		}
		const type = message?.type
		if (type === 'events' || type === 'resync') this.events.change()
	}

	private handleClose(code: number, reason: string): void {
		if (!this.active) return
		this.release()
		this.events.lost(code, reason, this.openedAt)
	}

	private handleError(): void {
		// Undici reports a refused upgrade (for example 401 or 503) only as `error`: no `close` follows and the socket
		// stays CONNECTING forever. After `open` a `close` does follow, and the pong check catches a silent socket.
		if (this.active && this.openedAt === 0) this.abandon('Screenbird refused the live connection')
	}

	private ping(): void {
		if (!this.active) return
		try {
			this.ws.send(PING_MESSAGE)
		} catch {
			// the pong check below notices a dead socket
		}
		if (!this.pongTimer) {
			this.pongTimer = setTimeout(
				() => this.abandon('Screenbird did not answer the live connection check'),
				PONG_TIMEOUT_MS,
			)
		}
	}

	/** Give up on a socket that hangs: a half-open TCP connection may not report its close for minutes. */
	private abandon(reason: string): void {
		if (!this.active) return
		this.release()
		try {
			this.ws.close()
		} catch {
			// already closed
		}
		this.events.warn(reason)
		this.events.lost(0, '', this.openedAt)
	}

	private release(): void {
		this.active = false
		this.clearHandshakeTimer()
		if (this.pongTimer) clearTimeout(this.pongTimer)
		if (this.pingTimer) clearInterval(this.pingTimer)
		this.pongTimer = this.pingTimer = null
	}

	private clearHandshakeTimer(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
		this.handshakeTimer = null
	}
}
