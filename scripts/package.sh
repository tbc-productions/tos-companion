#!/bin/sh
# Build the Chrome/Edge release zip with extension files only.
set -e
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
if [ -z "$version" ]; then
  echo "Could not read version from manifest.json" >&2
  exit 1
fi
mkdir -p dist
out="dist/tos-companion-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json background.js popup.html popup.css popup.js options.html options.js lib features icons -x '.*' '*/.*' '*.DS_Store'
echo "$out"
