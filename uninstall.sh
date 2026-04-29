#!/usr/bin/env bash
# Uninstall claude-throttle by removing its entries from ~/.claude/settings.json.
#
# Removes only entries that point at THIS repo's scripts. Leaves any
# other statusLine or PreToolUse hooks intact. Backs up before writing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
STATUSLINE_PATH="${REPO_ROOT}/scripts/statusline.sh"
THROTTLE_PATH="${REPO_ROOT}/scripts/throttle.sh"
SETTINGS_PATH="${HOME}/.claude/settings.json"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<EOF
Usage: uninstall.sh

Removes claude-throttle entries from ~/.claude/settings.json:
  - statusLine, only if it points at this repo's scripts/statusline.sh
  - PreToolUse hook entries that point at this repo's scripts/throttle.sh

Backs up settings.json before writing.
EOF
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$SETTINGS_PATH" ]]; then
  echo "Nothing to do: $SETTINGS_PATH does not exist."
  exit 0
fi

BACKUP_PATH="${SETTINGS_PATH}.backup-$(date +%s)"
cp "$SETTINGS_PATH" "$BACKUP_PATH"
echo "Backed up existing settings to: $BACKUP_PATH"

python3 - "$SETTINGS_PATH" "$STATUSLINE_PATH" "$THROTTLE_PATH" <<'PYEOF'
import json
import sys

settings_path, statusline_path, throttle_path = sys.argv[1:4]

with open(settings_path) as f:
    try:
        settings = json.load(f)
    except json.JSONDecodeError as e:
        print(f"error: {settings_path} is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

if not isinstance(settings, dict):
    print(f"error: {settings_path} top-level value must be an object", file=sys.stderr)
    sys.exit(1)

# --- statusLine ---
sl = settings.get("statusLine")
if isinstance(sl, dict) and sl.get("command") == statusline_path:
    settings.pop("statusLine")
    print(f"Removed statusLine -> {statusline_path}")
elif sl is not None:
    print(f"Left statusLine alone (points at something else): {sl!r}")
else:
    print("No statusLine to remove")

# --- PreToolUse hooks ---
hooks = settings.get("hooks")
removed_hook = False
if isinstance(hooks, dict):
    pre_tool_use = hooks.get("PreToolUse")
    if isinstance(pre_tool_use, list):
        new_blocks = []
        for mb in pre_tool_use:
            if not isinstance(mb, dict):
                new_blocks.append(mb)
                continue
            inner = mb.get("hooks") or []
            kept = [
                h for h in inner
                if not (isinstance(h, dict) and h.get("command") == throttle_path)
            ]
            if len(kept) != len(inner):
                removed_hook = True
            if kept:
                mb["hooks"] = kept
                new_blocks.append(mb)
            # else: drop the matcher block entirely (no inner hooks left)
        if new_blocks:
            hooks["PreToolUse"] = new_blocks
        else:
            hooks.pop("PreToolUse", None)
        # Clean up empty hooks dict
        if not hooks:
            settings.pop("hooks", None)

if removed_hook:
    print(f"Removed PreToolUse hook -> {throttle_path}")
else:
    print("No PreToolUse throttle hook to remove")

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PYEOF

echo
echo "Uninstalled. The throttle scripts are still at:"
echo "  ${REPO_ROOT}/scripts/"
echo "Delete the repo to remove them entirely."
