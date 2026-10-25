#!/bin/sh
# Substitutes __APP_URL__ in the served index.html at start-up: nginx.conf.template's own envsubst
# (20-envsubst-on-templates.sh, part of this base image) only covers /etc/nginx/templates, not
# files already in the webroot. Runs as the unprivileged nginx user (uid 101, web/Dockerfile), so
# the file is rewritten in place through /tmp rather than with `sed -i`, which needs to create a
# temporary file next to it in a directory that user does not own.
set -eu

html=/usr/share/nginx/html/index.html
if [ -f "$html" ]; then
  tmp=$(mktemp /tmp/index.html.XXXXXX)
  sed "s|__APP_URL__|${APP_URL:-}|g" "$html" > "$tmp"
  cat "$tmp" > "$html"
  rm -f "$tmp"
fi
