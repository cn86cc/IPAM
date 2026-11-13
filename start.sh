#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r backend/requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi

.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 &
BACK_PID=$!
(cd frontend && npm run dev) &
FRONT_PID=$!

trap 'kill "$BACK_PID" "$FRONT_PID" 2>/dev/null || true' EXIT INT TERM
echo "IPAM ready -> http://127.0.0.1:5173  (API http://127.0.0.1:8000/docs)"
wait
