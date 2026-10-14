# shellcheck disable=SC2154 # root is the sourcing script's checkout root
private_bun() {
  local candidate line repair runtime_dir tools candidates=() markers=()
  if [[ "$(uname -s)" == "Darwin" ]]; then
    runtime_dir="$HOME/Library/Application Support/PR Cockpit"
    candidates=("$runtime_dir/bun/bun")
    markers=("$runtime_dir/installed-rev" "$runtime_dir/launch" "$runtime_dir/bun")
    repair="$root/scripts/install"
  else
    tools="${XDG_DATA_HOME:-$HOME/.local/share}/pr-cockpit-tools"
    if [[ -r "${BASH_SOURCE[0]%/*}/install-linux-tools" ]]; then
      while IFS= read -r line; do
        if [[ "$line" =~ ^bun_version=\"([0-9]+\.[0-9]+\.[0-9]+)\"$ ]]; then candidates=("$tools/versions/bun-${BASH_REMATCH[1]}/bun"); break; fi
      done < "${BASH_SOURCE[0]%/*}/install-linux-tools"
    fi
    candidates+=("$tools/bin/bun")
    markers=("$tools")
    repair="$root/scripts/install-linux-tools"
  fi
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  for candidate in "${markers[@]}"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      echo "pr-cockpit: the installed app's private Bun is missing at ${candidates[0]}; run $repair to restore it" >&2
      return 1
    fi
  done
}
