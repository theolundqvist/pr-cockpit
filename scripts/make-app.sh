#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$HOME/Applications/PR Cockpit.app"
gh_bin="${COCKPIT_GH_BIN:-}"
if [[ -z "$gh_bin" || ! -x "$gh_bin" ]]; then
  gh_bin="$(command -v gh 2>/dev/null || true)"
fi
icon_hash="$(shasum -a 256 "$root/assets/icon.icns" | awk '{print substr($1, 1, 12)}')"
icon_name="pr-cockpit-$icon_hash"
icon_version="$(printf '%d' "0x${icon_hash:0:7}")"

rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS"

mkdir -p "$app_dir/Contents/Resources"
cp "$root/assets/icon.icns" "$app_dir/Contents/Resources/$icon_name.icns"

cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>PR Cockpit</string>
  <key>CFBundleIdentifier</key>
  <string>dev.theolundqvist.pr-cockpit</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIconFile</key>
  <string>$icon_name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>$icon_version</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

cat > "$app_dir/Contents/MacOS/launch" <<LAUNCH
#!/usr/bin/env bash
runtime_launcher="\$HOME/Library/Application Support/PR Cockpit/launch"
if [[ -x "\$runtime_launcher" ]]; then
  exec env COCKPIT_ROOT="$root" COCKPIT_LAUNCHER="\$runtime_launcher" COCKPIT_GH_BIN="$gh_bin" COCKPIT_NO_BUILD=1 "\$runtime_launcher" --managed-server --show "\$@"
fi
exec "$root/scripts/cockpit" "\$@"
LAUNCH

chmod +x "$app_dir/Contents/MacOS/launch"

echo "pr-cockpit: installed $app_dir"
