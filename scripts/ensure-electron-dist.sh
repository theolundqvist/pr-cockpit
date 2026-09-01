#!/usr/bin/env bash
set -euo pipefail

root="${1:?checkout root}"
bun="${2:-$(command -v bun)}"
electron_dir="$root/shell/node_modules/electron"
plist="$electron_dir/dist/Electron.app/Contents/Info.plist"

if [[ -f "$plist" ]]; then
  exit 0
fi

if [[ ! -f "$electron_dir/package.json" ]]; then
  echo "pr-cockpit: electron is not installed under $electron_dir" >&2
  exit 1
fi

version="$(grep -m1 '"version"' "$electron_dir/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
arch="$(uname -m)"
if [[ "$arch" != "arm64" ]]; then
  arch="x64"
fi

echo "pr-cockpit: downloading Electron archive for bundle repair..."
zip="$(
  cd "$electron_dir"
  ELECTRON_ARCH="$arch" "$bun" -e '
const path = require("node:path");
const { downloadArtifact } = require("@electron/get");
const root = process.cwd();
const { version } = require(path.join(root, "package.json"));
const archive = await downloadArtifact({
  version,
  artifactName: "electron",
  platform: "darwin",
  arch: process.env.ELECTRON_ARCH,
  checksums: require(path.join(root, "checksums.json")),
});
process.stdout.write(archive);
'
)"

if [[ -z "$zip" || ! -f "$zip" ]]; then
  echo "pr-cockpit: Electron downloader did not return an archive" >&2
  exit 1
fi

echo "pr-cockpit: repairing incomplete Electron.app (extract-zip omitted Info.plist and frameworks)..."
rm -rf "$electron_dir/dist"
mkdir -p "$electron_dir/dist"
ditto -xk "$zip" "$electron_dir/dist"
printf '%s\n' "Electron.app/Contents/MacOS/Electron" > "$electron_dir/path.txt"
printf 'v%s\n' "$version" > "$electron_dir/dist/version"

if [[ ! -f "$plist" ]]; then
  echo "pr-cockpit: Electron.app repair failed — Info.plist still missing" >&2
  exit 1
fi
