"""Run the ESO reminder harness and detect Fengari's zero-exit Lua errors."""
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
result = subprocess.run(
    ["npx.cmd" if os.name == "nt" else "npx", "--yes", "--package", "fengari-node-cli", "fengari", "ESO/tests/discord-reminder.lua"],
    cwd=root, capture_output=True, text=True,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
if result.returncode or "GuildSyncDiscordReminder queue tests passed" not in result.stdout:
    raise SystemExit(result.returncode or 1)
