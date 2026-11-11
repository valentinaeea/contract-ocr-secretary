#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$SCRIPT_DIR"
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$VENV_PYTHON" ] || ! "$VENV_PYTHON" -c 'import numpy,onnxruntime,pymupdf,tokenizers;from PIL import Image;import rapidocr_onnxruntime' >/dev/null 2>&1; then
  /bin/bash "$SCRIPT_DIR/install-mac.command" --no-pause
fi
exec "$VENV_PYTHON" "$SCRIPT_DIR/native/secretary_launcher.py" "$@"
