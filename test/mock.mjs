// Mock Screenbird API (HTTPS and WSS) for deterministic tests. Run with NODE_EXTRA_CA_CERTS pointing at the
// self-signed certificate, since the module only accepts https:// addresses.
// Each test can plan responses per request, delay them, refuse socket upgrades and simulate dead connections.
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'

const DIR = process.env.TEST_WORK_DIR || process.cwd()
const UUID = (prefix, i) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`

export function scene(i, extra = {}) {
	return {
		id: UUID('0', i),
		name: `Scene ${i}`,
		color: ['green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray'][i % 8],
		position: i,
		revision: 1,
		status: { state: 'off', deviating: [] },
		targets: [],
		...extra,
	}
}

export function screen(i, extra = {}) {
	return {
		id: UUID('1', i),
		name: `Screen ${i}`,
		paired: true,
		online: true,
		locked: false,
		content: null,
		live: { kind: 'normal' },
		subscreens: [],
		...extra,
	}
}

export function content(i, extra = {}) {
	return {
		id: UUID('2', i),
		name: `Content ${i}`,
		type: 'file',
		file_type: 'image',
		thumbnail_url: null,
		updated_at: '2026-10-23T10:00:00Z',
		...extra,
	}
}

export const json = (status, obj, headers = {}) => ({
	status,
	headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
	body: JSON.stringify(obj),
})
export const apiError = (status, code, message, headers = {}) => json(status, { error: { code, message } }, headers)

export function startMock() {
	const m = {
		scenes: [scene(1), scene(2), scene(3)],
		lastActivated: null,
		screens: [
			screen(1),
			screen(2, {
				subscreens: [
					{ id: UUID('3', 1), name: 'Left', live: { kind: 'normal' } },
					{ id: UUID('3', 2), name: 'Right', live: { kind: 'normal' } },
				],
			}),
		],
		content: [content(1), content(2, { type: 'design' })],
		plan: {}, // per "METHOD /path": queue of planned responses; empty = normal response
		delay: {}, // per "METHOD /path": queue of response delays in ms
		requests: [],
		upgrades: [],
		pings: 0,
		sockets: [],
		noPong: false, // ignore pings (a line that no longer answers)
		closeReplyDelay: 0, // >0: do not answer a client close; drop the TCP connection this many ms later (1006)
		upgradePlan: [], // planned answers to WebSocket upgrades, e.g. { status: 401 }
		eventsOnAction: true, // broadcast an events message after a successful POST, like the server does
		port: 0,
	}
	const server = https.createServer(
		{ key: fs.readFileSync(`${DIR}/key.pem`), cert: fs.readFileSync(`${DIR}/cert.pem`) },
		(req, res) => {
			const path = req.url.replace(/^\/v1/, '').split('?')[0]
			const rec = {
				at: Date.now(),
				method: req.method,
				path,
				url: req.url,
				ua: req.headers['user-agent'],
				client: req.headers['x-screenbird-client'],
				auth: req.headers.authorization ? 'yes' : 'no',
			}
			m.requests.push(rec)
			const key = `${req.method} ${path}`
			const planned = (m.plan[key] || []).shift()
			const delay = (m.delay[key] || []).shift() || 0
			// Snapshot the state when the request arrives (like a database read), not when the response is sent.
			const snap = JSON.parse(
				JSON.stringify({ scenes: m.scenes, last: m.lastActivated, screens: m.screens, content: m.content }),
			)
			let body = ''
			req.on('data', (d) => (body += d))
			req.on('end', () => {
				rec.body = body
				setTimeout(() => {
					let out = planned
					if (!out) {
						if (key === 'GET /scenes') out = json(200, { scenes: snap.scenes, last_activated: snap.last })
						else if (key === 'GET /screens') out = json(200, { screens: snap.screens })
						else if (key === 'GET /content') out = json(200, { items: snap.content })
						else if (req.method === 'POST') out = json(200, { scene: null, applied: 1, skipped: 0, released: 0 })
						else out = apiError(404, 'not_found', 'Not found.')
					}
					rec.status = out.status
					res.writeHead(out.status, out.headers || {})
					res.end(out.body ?? '')
					if (req.method === 'POST' && out.status === 200 && m.eventsOnAction) {
						setTimeout(
							() => m.broadcast({ type: 'events', events: [{ table: 'screen_live', op: 'insert', row: {} }] }),
							50,
						)
					}
				}, delay)
			})
		},
	)
	server.on('upgrade', (req, sock) => {
		const up = {
			at: Date.now(),
			path: req.url,
			auth: req.headers.authorization ? 'yes' : 'no',
			ua: req.headers['user-agent'],
		}
		m.upgrades.push(up)
		const planned = m.upgradePlan.shift()
		if (planned) {
			up.status = planned.status
			sock.end(`HTTP/1.1 ${planned.status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
			return
		}
		up.status = 101
		const keyHdr = req.headers['sec-websocket-key']
		const accept = crypto
			.createHash('sha1')
			.update(keyHdr + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
			.digest('base64')
		sock.write(
			[
				'HTTP/1.1 101 Switching Protocols',
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Accept: ${accept}`,
				'',
				'',
			].join('\r\n'),
		)
		const s = { n: m.sockets.length + 1, sock, closed: false, opened: Date.now(), pings: 0, clientClosedAt: null }
		m.sockets.push(s)
		let buf = Buffer.alloc(0)
		sock.on('data', (d) => {
			if (s.frozen) return
			buf = Buffer.concat([buf, d])
			while (buf.length >= 2) {
				const op = buf[0] & 0x0f
				let len = buf[1] & 0x7f
				let off = 2
				if (len === 126) {
					len = buf.readUInt16BE(2)
					off = 4
				} else if (len === 127) {
					len = Number(buf.readBigUInt64BE(2))
					off = 10
				}
				const masked = buf[1] & 0x80
				const maskOff = off
				if (masked) off += 4
				if (buf.length < off + len) break
				let payload = buf.subarray(off, off + len)
				if (masked) {
					const mask = buf.subarray(maskOff, maskOff + 4)
					payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
				}
				buf = buf.subarray(off + len)
				if (op === 1 && payload.toString() === '{"type":"ping"}') {
					m.pings++
					s.pings++
					if (!m.noPong) send(s, { type: 'pong' })
				}
				if (op === 8) {
					s.clientClosedAt = Date.now()
					if (m.closeReplyDelay > 0) {
						// like a server that never completes the close handshake: the client sees 1006 later
						const d = m.closeReplyDelay
						setTimeout(() => {
							s.closed = true
							sock.destroy()
						}, d)
					} else {
						s.closed = true
						try {
							sock.end(frame(8, payload))
						} catch {
							// The client may already have closed the socket.
						}
					}
				}
			}
		})
		sock.on('close', () => {
			s.closed = true
		})
		sock.on('error', () => {})
		send(s, { type: 'hello', ping: '{"type":"ping"}', interval_seconds: 30 })
	})
	function frame(op, payload) {
		const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
		let head
		if (p.length < 126) head = Buffer.from([0x80 | op, p.length])
		else if (p.length < 65536) {
			head = Buffer.alloc(4)
			head[0] = 0x80 | op
			head[1] = 126
			head.writeUInt16BE(p.length, 2)
		} else {
			head = Buffer.alloc(10)
			head[0] = 0x80 | op
			head[1] = 127
			head.writeBigUInt64BE(BigInt(p.length), 2)
		}
		return Buffer.concat([head, p])
	}
	function send(s, obj) {
		if (!s.closed && !s.frozen && !s.sock.destroyed) s.sock.write(frame(1, JSON.stringify(obj)))
	}
	m.broadcast = (obj) => m.sockets.forEach((s) => send(s, obj))
	m.closeAll = (code, reason = '') =>
		m.sockets.forEach((s) => {
			if (s.closed) return
			const p = Buffer.alloc(2 + Buffer.byteLength(reason))
			p.writeUInt16BE(code, 0)
			p.write(reason, 2)
			s.sock.write(frame(8, p))
			s.closed = true
			setTimeout(() => s.sock.destroy(), 50)
		})
	// Half-open line: the server neither receives nor sends anything, but TCP stays "open".
	m.freezeAll = () => m.sockets.forEach((s) => (s.frozen = true))
	m.openCount = () => m.sockets.filter((s) => !s.closed && !s.frozen).length
	m.reqs = (since = 0) =>
		m.requests.filter((r) => r.at >= since).map((r) => `${r.method} ${r.path} ${r.status ?? '...'}`)
	m.stop = () =>
		new Promise((r) => {
			m.sockets.forEach((s) => s.sock.destroy())
			server.close(() => r())
			server.closeAllConnections?.()
		})
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => {
			m.port = server.address().port
			m.url = `https://127.0.0.1:${m.port}/v1`
			resolve(m)
		}),
	)
}
