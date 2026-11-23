#!/usr/bin/env bash
# Usage: team-read <team-id> [agent-name] [--all|--wait|--ack ID ...]
set -euo pipefail

script_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
team_id="${1:?Usage: team-read <team-id> [agent-name] [--all|--wait|--ack ID ...]}"
case "$team_id" in ''|.|..|*[!a-zA-Z0-9_.-]*) exit 2 ;; esac
python3 - "$script_dir" "$@" <<'PY'
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

script_dir, team_id, *args = sys.argv[1:]
if '--ack' in args:
    position = args.index('--ack')
    ids = args[position + 1:]
    if position != 1 or not ids or len(ids) > 100 or len(set(ids)) != len(ids):
        raise SystemExit('Usage: team-read <team-id> <agent-name> --ack <id> [id ...]')
    subprocess.run([os.path.join(script_dir, 'team-say.sh'), team_id, args[0], 'ensemble',
                    '<<COLLAB_RECEIVED>> ' + json.dumps(ids)], check=True)
    raise SystemExit(0)

agent = next((arg for arg in args if not arg.startswith('--')), '')
if agent and not all(ord(char) < 128 and (char.isalnum() or char in '-_.') for char in agent):
    raise SystemExit('Invalid agent name')
agent_token = os.environ.get('ENSEMBLE_AGENT_TOKEN')
url = (os.environ.get('ENSEMBLE_AGENT_URL') if agent_token else None) or os.environ.get('ENSEMBLE_URL', 'http://localhost:23000')
endpoint = f'{url.rstrip("/")}/api/ensemble/teams/{urllib.parse.quote(team_id, safe="")}/feed'
if agent:
    endpoint += '?' + urllib.parse.urlencode({'recipient': agent})
token = agent_token or os.environ.get('ENSEMBLE_API_TOKEN')
request = urllib.request.Request(endpoint)
if token:
    request.add_unredirected_header('Authorization', 'Bearer ' + token)

def acknowledged(message):
    return any(item['recipient'] == agent and item['status'] == 'delivered'
               for item in message.get('delivery', []))

deadline = time.monotonic() + 120
while True:
    try:
        with urllib.request.urlopen(request, timeout=10) as result:
            messages = json.load(result).get('messages', [])
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Team API rejected the read (HTTP {error.code})')
    unread = [message for message in messages if not acknowledged(message)]
    if '--all' in args or '--wait' not in args or unread or time.monotonic() >= deadline:
        break
    time.sleep(3)

for message in messages if '--all' in args else unread:
    priority = '[urgent] ' if message.get('priority') == 'urgent' else ''
    print(f"[{message['id']}] {priority}{message['from']} -> {message['to']}: {message['content']}")
PY
