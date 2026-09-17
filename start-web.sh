#!/usr/bin/env bash
# YT Downloader Web — launcher simple sin dependencias
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "venv" ]; then
  echo "→ creando venv..."
  python3 -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
pip -q install -r requirements.txt

# chequeos
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "⚠ ffmpeg no encontrado — instala con: brew install ffmpeg (mac) / sudo apt install ffmpeg (linux)"
fi
if ! command -v node >/dev/null 2>&1 && ! command -v deno >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
  echo "⚠ runtime JS no encontrado (node/deno/bun) — yt-dlp puede fallar en algunos videos. Instala node: brew install node"
fi

PORT="${1:-8000}"
HOST="${2:-127.0.0.1}"
echo ""
echo "→ iniciando en http://$HOST:$PORT  (Ctrl+C para salir)"
echo "  carpeta descargas: ~/Downloads/YT"
echo ""
exec python server.py --host "$HOST" --port "$PORT" --open
