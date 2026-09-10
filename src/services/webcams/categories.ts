// Kept apart from ./index so the main-chunk SVG map can import the palette
// without pulling the camera catalogue and RPC client along with it.
// Camera TYPE is information, so categories stay distinguishable — but on the
// war-room ladder, not a rainbow. Traffic (roads, chokepoints) is the class a
// command center watches, so it takes the attention phosphor; city is nominal
// green; scenic classes share the informational green-grey; unknown is text-3.
// The emoji is only rendered when the user opts into emoji markers (GlobeMap
// webcamMarkerMode) and is kept for that path.
export const WEBCAM_CATEGORIES: Record<string, { color: string; emoji: string }> = {
  traffic:   { color: '#ffb000', emoji: '\u{1F697}' },    // amber — attention
  city:      { color: '#7df9c0', emoji: '\u{1F3D9}\uFE0F' }, // green — nominal
  landscape: { color: '#6f8f82', emoji: '\u{1F3D4}\uFE0F' }, // informational
  nature:    { color: '#6f8f82', emoji: '\u{1F33F}' },
  beach:     { color: '#6f8f82', emoji: '\u{1F3D6}\uFE0F' },
  water:     { color: '#6f8f82', emoji: '\u{1F30A}' },
  other:     { color: '#54635a', emoji: '\u{1F4F7}' },    // text-3
};

export function getCategoryStyle(category: string) {
  return WEBCAM_CATEGORIES[category] ?? WEBCAM_CATEGORIES.other!;
}
