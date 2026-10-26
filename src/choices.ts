import type { DropdownChoice } from '@companion-module/base'
import type { ContentItem, Scene, Screen } from './api.js'

const CONTENT_TYPE_LABELS: Record<string, string> = {
	file: 'file',
	design: 'design',
	app: 'app',
	split_screen: 'split screen',
	playlist: 'playlist',
}

/** Makes every label distinct: a name that occurs more than once gets " (1)", " (2)" in list order. */
export function distinctLabels(names: string[]): string[] {
	const total = new Map<string, number>()
	for (const name of names) total.set(name, (total.get(name) ?? 0) + 1)
	const seen = new Map<string, number>()
	return names.map((name) => {
		if ((total.get(name) ?? 0) < 2) return name
		const index = (seen.get(name) ?? 0) + 1
		seen.set(name, index)
		return `${name} (${index})`
	})
}

export function sceneChoices(scenes: Scene[]): DropdownChoice<string>[] {
	const labels = distinctLabels(scenes.map((s) => s.name))
	return scenes.map((s, i) => ({ id: s.id, label: labels[i] }))
}

/**
 * Screens and sub-screens that an action can target. The id is "<screen>" for a screen without sub-screens and
 * "<screen>/<subscreen>" for a sub-screen; a screen with sub-screens is only reachable through them.
 */
export function targetChoices(screens: Screen[]): DropdownChoice<string>[] {
	const choices: DropdownChoice<string>[] = []
	for (const screen of screens) {
		if (screen.subscreens.length === 0) choices.push({ id: screen.id, label: screen.name })
		for (const sub of screen.subscreens) {
			choices.push({ id: `${screen.id}/${sub.id}`, label: `${screen.name} / ${sub.name}` })
		}
	}
	const labels = distinctLabels(choices.map((c) => c.label))
	return choices.map((c, i) => ({ id: c.id, label: labels[i] }))
}

export function contentChoices(content: ContentItem[]): DropdownChoice<string>[] {
	const labels = distinctLabels(content.map((c) => `${c.name} (${CONTENT_TYPE_LABELS[c.type] ?? c.type})`))
	return content.map((c, i) => ({ id: c.id, label: labels[i] }))
}
