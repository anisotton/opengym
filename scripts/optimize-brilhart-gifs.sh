#!/usr/bin/env bash
# Re-encodes a Brilhart source GIF (as received from the Drive export) into what
# frontend/public/brilhart/ ships: a palette-reduced GIF under ~400 KB and a static
# first-frame .webp for the thumbnail/paused state. No new dependency — ffmpeg only
# (ISO-1605). The source GIFs run ~4 fps already, so this never resamples the frame
# rate up; palettegen/paletteuse with a small, diffed palette and a modest width is
# what gets a 570-945 KB export down to 308-380 KB without visible loss at the
# ~360px CSS display width this media is shown at (768px source, 2x DPR = 720px
# physical — well above what's actually needed, hence the resize).
#
# Usage: scripts/optimize-brilhart-gifs.sh <source.gif> <output-basename> [width] [colors]
# Example: scripts/optimize-brilhart-gifs.sh ~/scratch/01_preparatorio_quinta_frente_natural.gif \
#            frontend/public/brilhart/bf01-front 576 96
set -euo pipefail

src="$1"
out="$2"
width="${3:-576}"
colors="${4:-96}"

ffmpeg -y -v error -i "$src" \
  -vf "scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${colors}:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "${out}.gif"

ffmpeg -y -v error -i "$src" \
  -vf "scale=${width}:-1:flags=lanczos" -frames:v 1 -c:v libwebp -lossless 0 -quality 82 \
  "${out}.webp"

echo "${out}.gif: $(stat -c%s "${out}.gif") bytes"
echo "${out}.webp: $(stat -c%s "${out}.webp") bytes"
