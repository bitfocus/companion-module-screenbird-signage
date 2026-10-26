import type ModuleInstance from './main.js'

export type VariablesSchema = {
	last_scene: string
	next_scene: string
	live_scenes: string
	screens_online: number
	screens_total: number
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		last_scene: { name: 'Scene activated last' },
		next_scene: { name: 'Scene that "Scene: next" starts' },
		live_scenes: { name: 'Scenes that are live' },
		screens_online: { name: 'Screens online' },
		screens_total: { name: 'Screens in total' },
	})
}
