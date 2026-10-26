import type ModuleInstance from './main.js'
import { contentChoices, sceneChoices, targetChoices } from './choices.js'

export type ActionsSchema = {
	scene_activate: { options: { scene: string } }
	scene_release: { options: { scene: string } }
	scene_next: { options: Record<string, never> }
	release_all: { options: Record<string, never> }
	push: { options: { target: string; content: string; minutes: number } }
	screen_release: { options: { target: string } }
}

const MAX_PUSH_MINUTES = 1440

export function UpdateActions(self: ModuleInstance): void {
	const scenes = sceneChoices(self.scenes)
	const targets = targetChoices(self.screens)
	const content = contentChoices(self.content)
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

	self.setActionDefinitions({
		scene_activate: {
			name: 'Scene: go',
			description: 'Show this scene on all its screens. Pressing again puts changes live.',
			options: [sceneOption],
			callback: async (event) => self.runAction('Scene go', async (api) => api.activate(String(event.options.scene))),
		},
		scene_release: {
			name: 'Scene: stop',
			description: 'Stop this scene: its screens go back to their own content.',
			options: [sceneOption],
			callback: async (event) => self.runAction('Scene stop', async (api) => api.release(String(event.options.scene))),
		},
		scene_next: {
			name: 'Scene: next',
			description: 'Go to the scene after the one that was activated last, in the order of the Scenes page.',
			options: [],
			callback: async () => self.runAction('Next scene', async (api) => api.next()),
		},
		release_all: {
			name: 'Stop all',
			description: 'Stop all scenes and pushed content. Screen mirroring keeps running.',
			options: [],
			callback: async () => self.runAction('Stop all', async (api) => api.releaseAll()),
		},
		push: {
			name: 'Screen: push content',
			description: 'Show content on one screen or sub-screen.',
			options: [
				targetOption,
				{
					type: 'dropdown',
					id: 'content',
					label: 'Content',
					description: 'Files, designs, apps, split screens and playlists of the team, newest first.',
					choices: content,
					default: content[0]?.id ?? '',
				},
				{
					type: 'number',
					id: 'minutes',
					label: 'Minutes (0 = until stopped)',
					default: 0,
					min: 0,
					max: MAX_PUSH_MINUTES,
					asInteger: true,
				},
			],
			optionsToMonitorForSubscribe: ['content'],
			// Content has no live events: when a push action is added or changed, make sure the list is recent.
			subscribe: () => self.ensureRecentContent(),
			callback: async (event) =>
				self.runAction('Push', async (api) => {
					const target = self.resolveTarget(event.options.target)
					if (!target) throw new Error('this screen no longer exists')
					const contentId = String(event.options.content ?? '').trim()
					if (!contentId) throw new Error('choose the content to show')
					const minutes = Number(event.options.minutes) || 0
					const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null
					return api.push(target.screen.id, target.subscreenId, contentId, until)
				}),
		},
		screen_release: {
			name: 'Screen: stop',
			description: 'Stop pushed content or a scene on one screen or sub-screen.',
			options: [targetOption],
			callback: async (event) =>
				self.runAction('Screen stop', async (api) => {
					const target = self.resolveTarget(event.options.target)
					if (!target) throw new Error('this screen no longer exists')
					return api.releaseScreen(target.screen.id, target.subscreenId)
				}),
		},
	})
}
