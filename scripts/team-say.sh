#!/usr/bin/env bash
# Usage: team-say <team-id> <from> <to> <message>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="$1"; FROM="$2"; TO="$3"; shift 3
FILE="$(collab_messages_file "$TEAM_ID")"
python3 - "$TEAM_ID" "$FROM" "$TO" "$*" "$FILE" <<'PY'
import fcntl
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

team_id, sender, recipient, content, output_path = sys.argv[1:]
if team_id in ('', '.', '..') or not all(ord(c) < 128 and (c.isalnum() or c in '_.-') for c in team_id):
    raise SystemExit('Invalid team ID')
msg = {
    'id': str(uuid.uuid4()), 'teamId': team_id, 'from': sender, 'to': recipient,
    'content': content, 'type': 'chat',
}
token = os.environ.get('ENSEMBLE_AGENT_TOKEN')
receipt = content.startswith('<<COLLAB_RECEIVED>> ')
if token:
    url = os.environ.get('ENSEMBLE_AGENT_URL') or os.environ.get('ENSEMBLE_URL', 'http://localhost:23000')
    endpoint = url.rstrip('/') + '/api/ensemble/teams/' + urllib.parse.quote(team_id, safe='')
    request = urllib.request.Request(endpoint, data=json.dumps(msg).encode(), headers={
        'Content-Type': 'application/json',
    }, method='POST')
    request.add_unredirected_header('Authorization', 'Bearer ' + token)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=5):
                break
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 502, 503, 504) or attempt == 2:
                raise SystemExit(f'Team API rejected the message (HTTP {error.code})')
        except OSError:
            if attempt == 2:
                raise SystemExit('Team API delivery is unconfirmed')
        time.sleep(0.25 * 2 ** attempt)
    if receipt:
        print(f'Sent to {recipient}')
        sys.exit(0)
    # Keep a transcript for collab-launch. The bridge skips this mirror.
    msg['recordedViaApi'] = True
elif receipt or content.startswith('<<COLLAB_EVENT>> '):
    raise SystemExit('Workflow events and acknowledgements require an agent credential')

try:
    os.makedirs(os.path.dirname(output_path), mode=0o700, exist_ok=True)
    with open(output_path + '.lock', 'a', encoding='utf-8') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        msg['timestamp'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        with open(output_path, 'a', encoding='utf-8') as output:
            output.write(json.dumps(msg) + '\n')
except OSError:
    if not token:
        raise
    print('Message recorded by the service. Local transcript unavailable.', file=sys.stderr)
print(f'Sent to {recipient}')
PY
