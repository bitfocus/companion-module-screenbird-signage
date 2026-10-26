import { readFileSync } from 'node:fs'
import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import {
	describeError,
	parseApiUrl,
	ScreenbirdApi,
	TOKEN_RE,
	type ContentItem,
	type Scene,
	type Screen,
} from './api.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { Connection, type ConnectionHost } from './connection.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const PACKAGE_NAME = 'screenbird-signage'

/** The version from package.json: next to main.js in the built package, one folder up from dist/ during development. */
function moduleVersion(): string {
	for (const path of ['./package.json', '../package.json']) {
		try {
			const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
				name?: unknown
				version?: unknown
			}
			if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version
		} catch {
			// try the next location
		}
	}
	return '0.0.0'
}

const VERSION = moduleVersion()

export interface ActionTarget {
	screen: Screen
	subscreenId: string | null
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	scenes: Scene[] = []
	screens: Screen[] = []
	content: ContentItem[] = []
	lastActivated: string | null = null

	private connection: Connection | null = null
	private destroyed = false
	private lastStatusKey = ''
	private definitionKeys = { actions: '', feedbacks: '', presets: '' }

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.updateVariableDefinitions()
		this.publishState()
		this.connect(secrets)
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.disconnect()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.connect(secrets)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	/** Reload scenes and screens now. */
	async refresh(): Promise<void> {
		await this.connection?.refresh()
	}

	/** Run a button action. A failure throws, so Companion logs the action as failed. */
	async runAction(label: string, fn: (api: ScreenbirdApi) => Promise<unknown>): Promise<void> {
		const connection = this.connection
		const api = connection?.api
		if (!connection || !api) {
			throw new Error(`${label}: not connected to Screenbird (check the API token in the connection settings)`)
		}
		try {
			await fn(api)
		} catch (e) {
			connection.actionFailed(e)
			throw new Error(`${label} failed: ${describeError(e)}`, { cause: e })
		}
		// With an open live socket the resulting event brings the new state; without it, load the state now.
		const current = this.connection
		if (current && !current.isLive()) current.requestRefresh()
	}

	/** A push action was added or changed: make sure its content list is recent. */
	ensureRecentContent(): void {
		this.connection?.loadContent(true)
	}

	/**
	 * The scene that "Scene: next" (POST /v1/scenes/next) starts: the one after the last activated scene in the order
	 * of the Scenes page, wrapping around, or the first one when none was activated. The API lists scenes in that order.
	 */
	nextScene(): Scene | undefined {
		if (this.scenes.length === 0) return undefined
		const index = this.scenes.findIndex((s) => s.id === this.lastActivated)
		return this.scenes[(index + 1) % this.scenes.length]
	}

	sceneById(id: unknown): Scene | undefined {
		return this.scenes.find((s) => s.id === id)
	}

	/** Resolves a target dropdown value ("<screen>" or "<screen>/<subscreen>"); null when it no longer exists. */
	resolveTarget(value: unknown): ActionTarget | null {
		if (typeof value !== 'string') return null
		const [screenId, subscreenId] = value.split('/')
		const screen = this.screens.find((s) => s.id === screenId)
		if (!screen) return null
		if (subscreenId && !screen.subscreens.some((sub) => sub.id === subscreenId)) return null
		return { screen, subscreenId: subscreenId || null }
	}

	// ---- connection lifecycle ----

	private connect(secrets: ModuleSecrets | undefined): void {
		this.disconnect()
		const token = (secrets?.token ?? '').trim()
		if (!TOKEN_RE.test(token)) {
			this.halt(InstanceStatus.BadConfig, 'Add an API token from Screenbird (Settings > Connections > API tokens)')
			return
		}
		const baseUrl = parseApiUrl(this.config.apiUrl)
		if (!baseUrl) {
			this.halt(InstanceStatus.BadConfig, 'The API address must start with https:// and end with /v1')
			return
		}
		this.connection = new Connection(new ScreenbirdApi(baseUrl, token, VERSION), this.connectionHost())
		this.connection.start()
	}

	private disconnect(): void {
		this.connection?.stop()
		this.connection = null
	}

	/** Stop for good (bad config or token, no access to screens): no retries until the config is saved again. */
	private halt(status: InstanceStatus, message: string): void {
		this.disconnect()
		this.clearState()
		this.setStatus(status, message)
		this.log('warn', message)
	}

	private connectionHost(): ConnectionHost {
		return {
			log: (level, message) => {
				if (!this.destroyed) this.log(level, message)
			},
			setStatus: (status, message) => this.setStatus(status, message),
			stateLoaded: (state) => {
				this.scenes = state.scenes
				this.lastActivated = state.lastActivated
				this.screens = state.screens
				this.publishState()
			},
			contentLoaded: (items) => {
				this.content = items
				this.publishDefinitions()
			},
			halted: (status, message) => this.halt(status, message),
		}
	}

	/** Companion status, deduplicated, and never set after destroy. */
	private setStatus(status: InstanceStatus, message?: string): void {
		if (this.destroyed) return
		const key = `${status}|${message ?? ''}`
		if (key === this.lastStatusKey) return
		this.lastStatusKey = key
		this.updateStatus(status, message ?? null)
	}

	// ---- state to Companion ----

	private clearState(): void {
		this.scenes = []
		this.screens = []
		this.content = []
		this.lastActivated = null
		this.publishState()
	}

	private publishState(): void {
		this.publishDefinitions()
		this.setVariableValues({
			last_scene: this.sceneById(this.lastActivated)?.name ?? '',
			next_scene: this.nextScene()?.name ?? '',
			live_scenes: this.scenes
				.filter((s) => s.state === 'live')
				.map((s) => s.name)
				.join(', '),
			screens_online: this.screens.filter((s) => s.online).length,
			screens_total: this.screens.length,
		})
		this.checkAllFeedbacks()
	}

	/**
	 * Dropdown choices and presets depend on the scene, screen and content lists. Only redefine what actually changed:
	 * setting definitions on every event makes the Companion UI flicker.
	 */
	private publishDefinitions(): void {
		const scenes = this.scenes.map((s) => [s.id, s.name])
		const targets = this.screens.map((s) => [s.id, s.name, s.subscreens.map((sub) => [sub.id, sub.name])])
		const keys = {
			actions: JSON.stringify([scenes, targets, this.content.map((c) => [c.id, c.name, c.type])]),
			feedbacks: JSON.stringify([scenes, targets]),
			presets: JSON.stringify([this.scenes.map((s) => [s.id, s.name, s.color]), targets]),
		}
		if (keys.actions !== this.definitionKeys.actions) this.updateActions()
		if (keys.feedbacks !== this.definitionKeys.feedbacks) this.updateFeedbacks()
		if (keys.presets !== this.definitionKeys.presets) this.updatePresets()
		this.definitionKeys = keys
	}
}
