#!/usr/bin/env bash
# Usage: team-read <team-id> [agent-name] [--all|--wait]
set -euo pipefail

script_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
source "$script_dir/collab-paths.sh"
team_id="${1:?Usage: team-read <team-id> [agent-name] [--all|--wait]}"
case "$team_id" in ''|.|..|*[!a-zA-Z0-9_.-]*) exit 2 ;; esac
python3 - "$script_dir" "$(collab_messages_file "$team_id")" "$@" <<'PY'
import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

script_dir, journal, team_id, *args = sys.argv[1:]
agent = next((arg for arg in args if not arg.startswith('--')), '')
if agent:
    if not all(char.isascii() and (char.isalnum() or char in '-_.') for char in agent):
        raise SystemExit('Invalid agent name')
    os.makedirs(os.path.dirname(journal), mode=0o700, exist_ok=True)
    lock = open(journal + '.' + agent + '.inbox.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX)

received = set()
if agent and os.path.isfile(journal):
    with open(journal, encoding='utf-8') as local:
        for line in local:
            try:
                record = json.loads(line)
                content = record.get('content', '')
                if record.get('from') == agent and content.startswith('<<COLLAB_RECEIVED>> '):
                    received.update(json.loads(content.split(' ', 1)[1]))
            except (ValueError, AttributeError, TypeError):
                continue
url = os.environ.get('ENSEMBLE_URL', 'http://localhost:23000').rstrip('/')
endpoint = f'{url}/api/ensemble/teams/{urllib.parse.quote(team_id, safe="")}/feed'
if agent:
    endpoint += '?' + urllib.parse.urlencode({'recipient': agent})
headers = {}
if os.environ.get('ENSEMBLE_API_TOKEN'):
    headers['Authorization'] = 'Bearer ' + os.environ['ENSEMBLE_API_TOKEN']
deadline = time.monotonic() + 120
while True:
    with urllib.request.urlopen(urllib.request.Request(endpoint, headers=headers), timeout=10) as result:
        messages = json.load(result).get('messages', [])
    def delivery_for(message):
        return next((value for value in message.get('delivery', []) if value['recipient'] == agent), None)
    unread = [message for message in messages if message['id'] not in received and
              (not delivery_for(message) or delivery_for(message)['status'] != 'delivered')]
    if '--all' in args or '--wait' not in args or unread or time.monotonic() >= deadline:
        break
    time.sleep(3)

ids = []
for message in messages:
    receipt = delivery_for(message)
    if agent and '--all' not in args and (message['id'] in received or (receipt and receipt['status'] == 'delivered')):
        continue
    priority = '[urgent] ' if message.get('priority') == 'urgent' else ''
    print(f"{priority}{message['from']} -> {message['to']}: {message['content']}")
    if receipt and receipt['method'] == 'pull' and receipt['status'] == 'queued':
        ids.append(message['id'])
sys.stdout.flush()
# An empty receipt on wait timeout records a live, cooperative checkpoint.
for start in range(0, max(len(ids), int(bool(agent and '--wait' in args and not unread))), 100):
    subprocess.run([os.path.join(script_dir, 'team-say.sh'), team_id, agent, 'ensemble',
                    '<<COLLAB_RECEIVED>> ' + json.dumps(ids[start:start + 100])],
                   check=True, stdout=subprocess.DEVNULL)
PY
