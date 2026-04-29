#!/usr/bin/env bash
# Install claude-throttle by merging entries into ~/.claude/settings.json.
#
# Idempotent. Backs up the existing file before any modification.
# Refuses to clobber an existing statusLine without --force.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
STATUSLINE_PATH="${REPO_ROOT}/scripts/statusline.sh"
THROTTLE_PATH="${REPO_ROOT}/scripts/throttle.sh"
SETTINGS_PATH="${HOME}/.claude/settings.json"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--help)
      cat <<EOF
Usage: install.sh [--force]

Merges claude-throttle entries into ~/.claude/settings.json:
  - statusLine pointing at scripts/statusline.sh
  - PreToolUse hook pointing at scripts/throttle.sh

Backs up the existing settings.json before writing.

Options:
  -f, --force   Replace an existing statusLine if one is set.
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$STATUSLINE_PATH" ]]; then
  echo "error: $STATUSLINE_PATH is not executable" >&2
  exit 1
fi
if [[ ! -x "$THROTTLE_PATH" ]]; then
  # throttle.sh may not exist yet during early dev — warn but don't block.
  echo "warning: $THROTTLE_PATH is not executable (or missing) — install will still write the entry" >&2
fi

mkdir -p "$(dirname "$SETTINGS_PATH")"

if [[ -f "$SETTINGS_PATH" ]]; then
  BACKUP_PATH="${SETTINGS_PATH}.backup-$(date +%s)"
  cp "$SETTINGS_PATH" "$BACKUP_PATH"
  echo "Backed up existing settings to: $BACKUP_PATH"
fi

python3 - "$SETTINGS_PATH" "$STATUSLINE_PATH" "$THROTTLE_PATH" "$FORCE" <<'PYEOF'
import json
import os
import sys

settings_path, statusline_path, throttle_path, force_str = sys.argv[1:5]
force = force_str == "1"

if os.path.exists(settings_path):
    with open(settings_path) as f:
        try:
            settings = json.load(f)
        except json.JSONDecodeError as e:
            print(f"error: {settings_path} is not valid JSON: {e}", file=sys.stderr)
            sys.exit(1)
    if not isinstance(settings, dict):
        print(f"error: {settings_path} top-level value must be an object", file=sys.stderr)
        sys.exit(1)
else:
    settings = {}

# --- statusLine ---
existing_sl = settings.get("statusLine")
desired_sl = {"type": "command", "command": statusline_path}

if existing_sl is None:
    settings["statusLine"] = desired_sl
    print(f"Set statusLine -> {statusline_path}")
elif existing_sl == desired_sl:
    print("statusLine already configured (no change)")
else:
    if not force:
        existing_cmd = existing_sl.get("command", "<unknown>") if isinstance(existing_sl, dict) else repr(existing_sl)
        print(
            f"error: a different statusLine is already configured:\n"
            f"  current: {existing_cmd}\n"
            f"  desired: {statusline_path}\n"
            f"\n"
            f"Re-run with --force to replace it, or wrap our script from yours:\n"
            f"\n"
            f"  #!/usr/bin/env bash\n"
            f"  input=$(cat)\n"
            f"  # forward to claude-throttle's writer (it consumes stdin and prints status)\n"
            f"  echo \"$input\" | {statusline_path}\n"
            f"  # then run your own statusline logic and print whatever you want\n",
            file=sys.stderr,
        )
        sys.exit(3)
    settings["statusLine"] = desired_sl
    print(f"Replaced statusLine -> {statusline_path} (forced)")

# --- PreToolUse hook ---
hooks = settings.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print("error: hooks must be an object", file=sys.stderr)
    sys.exit(1)
pre_tool_use = hooks.setdefault("PreToolUse", [])
if not isinstance(pre_tool_use, list):
    print("error: hooks.PreToolUse must be an array", file=sys.stderr)
    sys.exit(1)

def has_throttle_command(matcher_block):
    if not isinstance(matcher_block, dict):
        return False
    inner = matcher_block.get("hooks") or []
    return any(
        isinstance(h, dict) and h.get("command") == throttle_path
        for h in inner
    )

already_present = any(has_throttle_command(mb) for mb in pre_tool_use)
if already_present:
    print("PreToolUse throttle hook already configured (no change)")
else:
    pre_tool_use.append({
        "matcher": "*",
        "hooks": [
            {"type": "command", "command": throttle_path, "timeout": 600}
        ],
    })
    print(f"Added PreToolUse hook -> {throttle_path}")

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF

echo
echo "Installed. To activate throttling in a session:"
echo "  export CLAUDE_THROTTLE=0.9"
echo "  claude"
echo
echo "Unset CLAUDE_THROTTLE (or set to 0/empty) for normal operation."
