#!/bin/sh
set -eu

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_dir=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode}
plugin_dir=$config_dir/plugins
command_dir=$config_dir/commands

symlink_targets_match() {
  source=$1
  destination=$2
  target=$3

  case "$target" in
    /*) resolved_target=$target ;;
    *) resolved_target=$(dirname -- "$destination")/$target ;;
  esac

  source_parent=$(CDPATH= cd -P -- "$(dirname -- "$source")" 2>/dev/null && pwd) || return 1
  target_parent=$(CDPATH= cd -P -- "$(dirname -- "$resolved_target")" 2>/dev/null && pwd) || return 1
  [ "$source_parent/$(basename -- "$source")" = "$target_parent/$(basename -- "$resolved_target")" ]
}

remove_our_link() {
  source=$1
  destination=$2

  if [ ! -L "$destination" ]; then
    if [ -e "$destination" ]; then
      printf 'kept non-symlink: %s\n' "$destination"
    else
      printf 'already absent: %s\n' "$destination"
    fi
    return
  fi

  current_target=$(readlink "$destination") || {
    printf 'opencode-codex-goal: error: cannot read symlink: %s\n' "$destination" >&2
    exit 1
  }
  if [ "$current_target" = "$source" ] || symlink_targets_match "$source" "$destination" "$current_target"; then
    rm "$destination"
    printf 'removed: %s\n' "$destination"
  else
    printf 'kept unrelated symlink: %s -> %s\n' "$destination" "$current_target"
  fi
}

remove_our_link "$repository_dir/plugin/goal.ts" "$plugin_dir/opencode-codex-goal.ts"
remove_our_link "$repository_dir/plugin/goalpkg" "$plugin_dir/goalpkg"
remove_our_link "$repository_dir/command/goal.md" "$command_dir/goal.md"

printf 'OpenCode 1.x Goal Plugin links removed; project Goal state was not touched.\n'
