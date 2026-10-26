import type ModuleInstance from './main.js'
import { sceneChoices, targetChoices } from './choices.js'
import { CHANGED_BG, PARTIAL_BG, SCREEN_STATE_BG, WHITE, sceneColor, textOn } from './colors.js'

export type FeedbacksSchema = {
	scene_live: { type: 'boolean'; options: { scene: string } }
	scene_partial: { type: 'boolean'; options: { scene: string } }
	scene_changed: { type: 'boolean'; options: { scene: string } }
	screen_state: { type: 'boolean'; options: { target: string; state: string } }
	screen_online: { type: 'boolean'; options: { target: string } }
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const scenes = sceneChoices(self.scenes)
	const targets = targetChoices(self.screens)
	const sceneOption = {
		type: 'dropdown',
		id: 'scene',
		label: 'Scene',
		choices: scenes,
		default: scenes[0]?.id ?? '',
	} as const
	const targetOption = {
		type: 'dropdown',
		id: 'target',
		label: 'Screen',
		choices: targets,
		default: targets[0]?.id ?? '',
	} as const
	const green = sceneColor('green')

	self.setFeedbackDefinitions({
		scene_live: {
			type: 'boolean',
			name: 'Scene is live',
			description: 'All screens of the scene show it.',
			defaultStyle: { bgcolor: green, color: textOn(green) },
			options: [sceneOption],
			callback: (feedback) => self.sceneById(feedback.options.scene)?.state === 'live',
		},
		scene_partial: {
			type: 'boolean',
			name: 'Scene is partly live',
			description: 'Some screens of the scene show something else.',
			defaultStyle: { bgcolor: PARTIAL_BG, color: WHITE },
			options: [sceneOption],
			callback: (feedback) => self.sceneById(feedback.options.scene)?.state === 'partial',
		},
		scene_changed: {
			type: 'boolean',
			name: 'Scene changed since it went live',
			description: 'Press the scene again to put the changes live.',
			defaultStyle: { bgcolor: CHANGED_BG, color: WHITE },
			options: [sceneOption],
			callback: (feedback) => self.sceneById(feedback.options.scene)?.state === 'stale',
		},
		screen_state: {
			type: 'boolean',
			name: 'Screen shows',
			description: 'What a screen or sub-screen shows right now.',
			defaultStyle: { bgcolor: SCREEN_STATE_BG, color: WHITE },
			options: [
				targetOption,
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: [
						{ id: 'scene', label: 'A scene' },
						{ id: 'push', label: 'Pushed content' },
						{ id: 'mirror', label: 'Screen mirror' },
						{ id: 'normal', label: 'Normal content' },
					],
					default: 'scene',
				},
			],
			callback: (feedback) => {
				const target = self.resolveTarget(feedback.options.target)
				if (!target) return false
				const live = target.subscreenId
					? target.screen.subscreens.find((sub) => sub.id === target.subscreenId)?.live
					: target.screen.live
				return (live ?? 'normal') === feedback.options.state
			},
		},
		screen_online: {
			type: 'boolean',
			name: 'Screen is online',
			defaultStyle: { bgcolor: green, color: textOn(green) },
			options: [targetOption],
			callback: (feedback) => self.resolveTarget(feedback.options.target)?.screen.online === true,
		},
	})
}
