import type { SomeCompanionConfigField } from '@companion-module/base'
import { DEFAULT_API_URL, TOKEN_RE } from './api.js'

export type ModuleConfig = {
	apiUrl: string
}

export type ModuleSecrets = {
	token: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'API token',
			value:
				'Create a token in Screenbird under Settings > Connections > API tokens, with access "Control screens and scenes".',
			width: 12,
		},
		{
			type: 'secret-text',
			id: 'token',
			label: 'API token',
			width: 12,
			regex: TOKEN_RE.toString(),
		},
		{
			type: 'textinput',
			id: 'apiUrl',
			label: 'API address',
			description:
				'Leave as is, unless Screenbird support gives you another address. Only https:// addresses ending in /v1 work.',
			width: 12,
			default: DEFAULT_API_URL,
			// Same rule as parseApiUrl() in api.ts, so the UI rejects what the module would reject. Empty means the default.
			regex: '/^$|^https:\\/\\/[^\\s/?#@]+(\\/[^\\s?#]*)?\\/v1\\/?$/',
		},
	]
}
