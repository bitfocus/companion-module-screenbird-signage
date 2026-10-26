import { InstanceStatus } from '@companion-module/base'
import { ApiError, describeError } from './api.js'

/** How often to check again when the account is inactive or the token lacks a permission. */
export const SLOW_RETRY_MS = 5 * 60_000

const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

/**
 * What a failed call means for the connection:
 * - `halt`: stop until the user saves the config again (bad or revoked token, wrong scope)
 * - `slow`: drop the live socket and check again every SLOW_RETRY_MS
 * - `retry`: retry with backoff, or after `retryAfterMs` when the API asked for it
 */
export type Failure = {
	kind: 'halt' | 'slow' | 'retry'
	status: InstanceStatus
	message: string
	retryAfterMs?: number
}

/** Result of loading the state. `stale` means the connection was stopped while the request was in flight. */
export type Outcome = { kind: 'ok' } | { kind: 'stale' } | Failure

/**
 * Maps an error from the API client to a Failure. While the live socket is open the module keeps working on its last
 * known state, so transient errors only raise a warning instead of a connection failure.
 */
export function classifyError(e: unknown, live: boolean): Failure {
	if (!(e instanceof ApiError)) {
		return { kind: 'retry', status: InstanceStatus.UnknownError, message: describeError(e) }
	}
	const transient = live ? InstanceStatus.UnknownWarning : InstanceStatus.ConnectionFailure
	if (e.status === 401) {
		return {
			kind: 'halt',
			status: InstanceStatus.AuthenticationFailure,
			message: 'The API token is invalid or was revoked. Create a new token in Screenbird and paste it here.',
		}
	}
	if (e.status === 403 && e.code === 'insufficient_scope') {
		return {
			kind: 'halt',
			status: InstanceStatus.InsufficientPermissions,
			message: 'The API token has no access to screens. Create a token with access "Control screens and scenes".',
		}
	}
	if (e.status === 403 && e.code === 'account_inactive') {
		return {
			kind: 'slow',
			status: InstanceStatus.ConnectionFailure,
			message: 'The Screenbird account has no active subscription. Checking again every 5 minutes.',
		}
	}
	if (e.status === 403) {
		return {
			kind: 'slow',
			status: InstanceStatus.InsufficientPermissions,
			message: `${e.message} Checking again every 5 minutes.`,
		}
	}
	if (e.status === 429) {
		const retryAfterMs = e.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS
		return {
			kind: 'retry',
			status: transient,
			message: `Screenbird asks to slow down. Trying again in ${Math.ceil(retryAfterMs / 1000)} s.`,
			retryAfterMs,
		}
	}
	if (e.code === 'invalid_response' || e.status === 404) {
		return {
			kind: 'retry',
			status: InstanceStatus.ConnectionFailure,
			message:
				'The API address does not answer like the Screenbird API. Check the API address in the connection settings.',
		}
	}
	return {
		kind: 'retry',
		status: transient,
		message: e.status === 0 ? e.message : `Screenbird answered with an error (${e.code}).`,
	}
}
