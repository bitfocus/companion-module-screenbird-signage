/** Scene colors as shown in the Screenbird dashboard. */
const SCENE_COLORS: Record<string, number> = {
	green: 0x4caf50,
	blue: 0x4753e0,
	purple: 0x7c4dff,
	orange: 0xf5a623,
	red: 0xef5350,
	teal: 0x009688,
	pink: 0xe91e63,
	gray: 0x9e9e9e,
}

export const CHANGED_BG = 0x8a5a00
export const PARTIAL_BG = 0x5a4a00
export const RELEASE_BG = 0x7a1010
export const SCREEN_STATE_BG = 0xcc0000
export const NEUTRAL_BG = 0x262626
export const DARK_BG = 0x1a1a1a
export const WHITE = 0xffffff
export const BLACK = 0x000000

/** The RGB value of a scene color name; unknown names fall back to blue. */
export function sceneColor(name: string): number {
	return SCENE_COLORS[name] ?? SCENE_COLORS.blue
}

function linearChannel(value: number): number {
	const s = value / 255
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: number): number {
	return (
		0.2126 * linearChannel((color >> 16) & 0xff) +
		0.7152 * linearChannel((color >> 8) & 0xff) +
		0.0722 * linearChannel(color & 0xff)
	)
}

/** Black or white, whichever has the higher WCAG contrast on this background. */
export function textOn(bg: number): number {
	const l = relativeLuminance(bg)
	return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? BLACK : WHITE
}

function mapChannels(color: number, fn: (value: number) => number): number {
	const channel = (shift: number) => Math.round(fn((color >> shift) & 0xff))
	return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

/** The color at a fraction of its brightness (0.25 is clearly off, 0.55 halfway). */
export function shade(color: number, factor: number): number {
	return mapChannels(color, (v) => v * factor)
}

/** The color mixed with white, so it stays readable as text on a dark button. */
export function tint(color: number, factor: number): number {
	return mapChannels(color, (v) => v + (255 - v) * factor)
}
