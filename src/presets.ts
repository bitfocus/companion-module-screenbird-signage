import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import { distinctLabels, targetChoices } from './choices.js'
import { CHANGED_BG, DARK_BG, NEUTRAL_BG, RELEASE_BG, sceneColor, shade, textOn, tint } from './colors.js'

/**
 * A name as button text. Companion reads "$(" as the start of a variable and "\n" as a line break, so a scene or
 * screen name must not pass either through.
 */
export function buttonText(name: string): string {
	return name.replace(/\$\(/g, '$ (').replace(/\\n/g, '\\ n')
}

export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const scenePresets: string[] = []
	const sceneReleasePresets: string[] = []
	const screenPresets: string[] = []
	const sceneNames = distinctLabels(self.scenes.map((s) => s.name))

	self.scenes.forEach((scene, i) => {
		const color = sceneColor(scene.color)
		const off = shade(color, 0.25)
		const partial = shade(color, 0.55)
		const text = buttonText(scene.name)

		const goId = `scene_${scene.id}`
		presets[goId] = {
			type: 'simple',
			name: sceneNames[i],
			style: { text, size: 'auto', color: textOn(off), bgcolor: off, show_topbar: false },
			steps: [{ down: [{ actionId: 'scene_activate', options: { scene: scene.id } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'scene_live', options: { scene: scene.id }, style: { bgcolor: color, color: textOn(color) } },
				{
					feedbackId: 'scene_partial',
					options: { scene: scene.id },
					style: { bgcolor: partial, color: textOn(partial) },
				},
				{
					feedbackId: 'scene_changed',
					options: { scene: scene.id },
					style: { bgcolor: CHANGED_BG, color: textOn(CHANGED_BG), text: `${text}\\n(changed)` },
				},
			],
		}
		scenePresets.push(goId)

		const releaseId = `scene_release_${scene.id}`
		presets[releaseId] = {
			type: 'simple',
			name: `${sceneNames[i]}: stop`,
			style: { text: `${text}\\nstop`, size: 'auto', color: tint(color, 0.5), bgcolor: DARK_BG, show_topbar: false },
			steps: [{ down: [{ actionId: 'scene_release', options: { scene: scene.id } }], up: [] }],
			feedbacks: [],
		}
		sceneReleasePresets.push(releaseId)
	})

	// One stop button per screen or sub-screen, lit while a scene or pushed content shows on it.
	const lit = { bgcolor: RELEASE_BG, color: textOn(RELEASE_BG) }
	for (const target of targetChoices(self.screens)) {
		const id = `screen_release_${target.id.replace('/', '_')}`
		presets[id] = {
			type: 'simple',
			name: `${target.label}: stop`,
			style: {
				text: `${buttonText(target.label)}\\nstop`,
				size: 'auto',
				color: textOn(NEUTRAL_BG),
				bgcolor: NEUTRAL_BG,
				show_topbar: false,
			},
			steps: [{ down: [{ actionId: 'screen_release', options: { target: target.id } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'screen_state', options: { target: target.id, state: 'scene' }, style: lit },
				{ feedbackId: 'screen_state', options: { target: target.id, state: 'push' }, style: lit },
			],
		}
		screenPresets.push(id)
	}

	presets.release_all = {
		type: 'simple',
		name: 'Stop all',
		style: { text: 'STOP\\nALL', size: 'auto', color: textOn(RELEASE_BG), bgcolor: RELEASE_BG, show_topbar: false },
		steps: [{ down: [{ actionId: 'release_all', options: {} }], up: [] }],
		feedbacks: [],
	}
	presets.scene_next = {
		type: 'simple',
		name: 'Next scene',
		// Companion rewrites `$(screenbird:...)` in preset text to the label of the connection the preset is used with.
		// Without scenes the variable is empty and the button just says NEXT.
		style: {
			text: 'NEXT\\n$(screenbird:next_scene)',
			size: 'auto',
			color: textOn(NEUTRAL_BG),
			bgcolor: NEUTRAL_BG,
			show_topbar: false,
		},
		previewStyle: { text: 'NEXT\\nSCENE' },
		steps: [{ down: [{ actionId: 'scene_next', options: {} }], up: [] }],
		feedbacks: [],
	}

	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'scenes',
			name: 'Scenes',
			description: 'One button per scene. Full color when live, half bright when partly live, dark when off.',
			definitions: [
				{ id: 'scenes_go', type: 'simple', name: 'Go', presets: scenePresets },
				{ id: 'scenes_release', type: 'simple', name: 'Stop', presets: sceneReleasePresets },
			],
		},
		{
			id: 'control',
			name: 'Control',
			definitions: [
				{ id: 'control_main', type: 'simple', name: 'All screens', presets: ['release_all', 'scene_next'] },
			],
		},
		{
			id: 'screens',
			name: 'Screens',
			description: 'Back to normal per screen or sub-screen. Lit while a scene or pushed content shows on it.',
			definitions: [{ id: 'screens_release', type: 'simple', name: 'Back to normal', presets: screenPresets }],
		},
	]

	self.setPresetDefinitions(structure, presets)
}
