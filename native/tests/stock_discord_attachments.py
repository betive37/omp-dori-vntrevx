"""Native attachment-reference wire and fail-closed cursor contract, loopback only."""
import json
import subprocess
from pathlib import Path

from discord_wire import message


def exercise_attachments(binary, env, root, world):
    original = list(world.history)
    attachment = {"id": "500", "filename": "file.pdf", "size": 7,
                  "url": "https://cdn.discordapp.com/attachments/20/500/file.pdf?hm=synthetic-signature"}
    try:
        for case in ("valid", "missing", "duplicate", "negative"):
            state = root / f"attachment-{case}"
            cursor = state / "discord-inbound" / "20.json"
            cursor.parent.mkdir(parents=True, mode=0o700)
            cursor.write_text(json.dumps({"version": 1, "channelId": "20", "cursor": "100"}), encoding="utf-8")
            cursor.chmod(0o600)
            item = dict(attachment)
            if case == "missing":
                item.pop("id")
            if case == "negative":
                item["size"] = -1
            values = [item, dict(item)] if case == "duplicate" else [item]
            world.history[:] = [{**message("101", "read this"), "attachments": values}]
            argv = [binary, "discord", "--channel", "20", "--cataly-state", str(state),
                    "--poll-seconds", "0", "--attachment-refs"]
            result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=20, check=False)
            assert "synthetic-signature" not in result.stdout + result.stderr, result
            if case == "valid":
                assert result.returncode == 0 and "discord-file:99:10:20:101:500" in result.stdout, result
                assert '"url"' not in result.stdout, result
                assert json.loads(cursor.read_text())["cursor"] == "101"
                repeated = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=20, check=False)
                assert repeated.returncode == 0 and "INBOUND_ATTACHMENT" not in repeated.stdout, repeated
            else:
                assert result.returncode != 0, result
                assert "INBOUND discord " not in result.stdout, result
                assert json.loads(cursor.read_text())["cursor"] == "100"
    finally:
        world.history[:] = original
