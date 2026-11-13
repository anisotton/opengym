// Which of the sideloaded APKs this is: Standard (180 px built in), Plus (240 px) or HD (360 px).
// The same app each time, only the exercise animations inside differ (scripts/android/build-release.sh
// sets VITE_APK_VARIANT with VITE_BUILTIN_CLIP_PX). lib/update.js updates each kind only to
// itself; Settings → About shows which one a phone has. Its own module so the About page can read
// it without the updater.
// Brilhart Fitness ships no dataset animations (ISO-1601), so every build is the Standard kind:
// the 180 px openGym's Standard APK has built in.
const BUILTIN_PX = 180

const ENV = import.meta.env || {}
export const APK_VARIANTS = ['standard', 'plus', 'hd']
/** A build without VITE_APK_VARIANT goes by what it has built in. */
export const variantFor = (env, px = BUILTIN_PX) => APK_VARIANTS.includes(env)
  ? env
  : (px >= 360 ? 'hd' : px > 180 ? 'plus' : 'standard')
export const APK_VARIANT = variantFor(ENV.VITE_APK_VARIANT)
/** The kind's name as the download page and the file names call it. */
export const VARIANT_NAMES = { standard: 'Standard', plus: 'Plus', hd: 'HD' }
