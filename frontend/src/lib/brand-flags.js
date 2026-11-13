// Brilhart Fitness: upstream features this fork keeps in the code but off on screen, in one place
// every module can import (Settings, the seasonal themes) without pulling in a whole view.

// Upstream's alternate app icons carry openGym's logo, hidden until Brilhart has its own set. Off,
// Look & Home has no App icon row, Seasonal themes no shortcut to a seasonal icon, and the
// Christmas theme neither suggests its icon on Home nor offers it behind the advent's last door.
// The files (components/AppIconRow.jsx, lib/app-icon*.js, public/app-icons, resources/icons) stay
// so later upstream merges remain small.
export const APP_ICON_PICKER = false

// The accent is the brand's, fixed in index.css (plum --acc/--acc-2/--on-acc/--acc-ink), as in
// release/0.0.0-alpha. Off: no Accent color row, no seasonal "Spooky/Festive colors" switches, no
// search entries for them; App.jsx applies no data-accent either. lib/accent.js stays.
export const ACCENT_PICKER = false
