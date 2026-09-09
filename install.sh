#!/bin/sh
set -eu

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_dir=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode}
plugin_dir=$config_dir/plugins
command_dir=$config_dir/commands

fail() {
  printf 'opencode-codex-goal: error: %s\n' "$*" >&2
  exit 1
}

link_into() {
  source=$1
  destination=$2

  [ -e "$source" ] || fail "source does not exist: $source"

  if [ -L "$destination" ]; then
    current_target=$(readlink "$destination") || fail "cannot read existing symlink: $destination"
    if [ "$current_target" = "$source" ] || symlink_targets_match "$source" "$destination" "$current_target"; then
      printf 'already linked: %s\n' "$destination"
      return
    fi
    fail "refusing to replace existing symlink: $destination -> $current_target"
  elif [ -e "$destination" ]; then
    fail "refusing to overwrite existing file or directory: $destination"
  fi

  ln -s "$source" "$destination" || fail "could not create symlink: $destination"
  printf 'linked: %s -> %s\n' "$destination" "$source"
}

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

mkdir -p "$plugin_dir" "$command_dir" || fail "could not create OpenCode directories under $config_dir"

# The helper directory is linked because goal.ts imports ./goalpkg/*.ts.
link_into "$repository_dir/plugin/goal.ts" "$plugin_dir/opencode-codex-goal.ts"
link_into "$repository_dir/plugin/goalpkg" "$plugin_dir/goalpkg"
link_into "$repository_dir/command/goal.md" "$command_dir/goal.md"

printf 'OpenCode 1.x Goal Plugin installed for config directory: %s\n' "$config_dir"
