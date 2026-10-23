/**
 * calendarList.backgroundColor still uses Google's classic 24-colour palette, while the Calendar web and
 * mobile apps draw the same calendars with the modern palette. Map classic → modern so the block matches
 * what the user sees in Google; custom colours (not in the palette) pass through unchanged.
 */
const CLASSIC_TO_MODERN: Record<string, string> = {
	'#ac725e': '#795548', // Cocoa
	'#d06b64': '#e67c73', // Flamingo
	'#f83a22': '#d50000', // Tomato
	'#fa573c': '#f4511e', // Tangerine
	'#ff7537': '#ef6c00', // Pumpkin
	'#ffad46': '#f09300', // Mango
	'#42d692': '#009688', // Eucalyptus
	'#16a765': '#0b8043', // Basil
	'#7bd148': '#7cb342', // Pistachio
	'#b3dc6c': '#c0ca33', // Avocado
	'#fbe983': '#e4c441', // Citron
	'#fad165': '#f6bf26', // Banana
	'#92e1c0': '#33b679', // Sage
	'#9fe1e7': '#039be5', // Peacock
	'#9fc6e7': '#4285f4', // Cobalt
	'#4986e7': '#3f51b5', // Blueberry
	'#9a9cff': '#7986cb', // Lavender
	'#b99aff': '#b39ddb', // Wisteria
	'#c2c2c2': '#616161', // Graphite
	'#cabdbf': '#a79b8e', // Birch
	'#cca6ac': '#ad1457', // Radicchio
	'#f691b2': '#d81b60', // Cherry Blossom
	'#cd74e6': '#8e24aa', // Grape
	'#a47ae2': '#9e69af', // Amethyst
};

export function modernColor(hex: string): string {
	return CLASSIC_TO_MODERN[hex.toLowerCase()] ?? hex;
}
