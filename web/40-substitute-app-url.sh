#!/bin/sh
# Runs before nginx starts (nginx:alpine's docker-entrypoint.d convention — see
# 20-envsubst-on-templates.sh, which handles nginx.conf.template the same way). index.html is a
# static file baked into the image, not one of the templates that script renders, so it needs its
# own substitution: the __APP_URL__ marker (frontend/index.html's og:url/og:image tags) becomes
# APP_URL for this environment, with no rebuild per deployment.
set -eu

html=/usr/share/nginx/html/index.html
if [ -f "$html" ]; then
  sed -i "s|__APP_URL__|${APP_URL:-}|g" "$html"
fi
