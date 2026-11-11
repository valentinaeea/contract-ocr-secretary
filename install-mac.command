#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$SCRIPT_DIR"
trap 'echo "安装失败，请保留上方报错。"; read -r -p "按 Enter 关闭…"' ERR
PYTHON="${CONTRACT_OCR_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 /usr/local/bin/python3.11 /opt/homebrew/bin/python3 python3; do
    if "$candidate" -c 'import sys; assert sys.version_info[:2]==(3,11)' 2>/dev/null; then PYTHON="$candidate"; break; fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "新 Mac 首次需要 Python 3.11：https://www.python.org/downloads/macos/"
  read -r -p "按 Enter 关闭…"
  exit 1
fi
if [ ! -x "$SCRIPT_DIR/.venv/bin/python" ]; then "$PYTHON" -m venv "$SCRIPT_DIR/.venv"; fi
"$SCRIPT_DIR/.venv/bin/python" -m pip install -r requirements-native.txt
"$SCRIPT_DIR/.venv/bin/python" -c 'import numpy,onnxruntime,pymupdf,tokenizers; from PIL import Image; import rapidocr_onnxruntime'
echo "安装完成，以后双击 start-mac.command。模型已包含，不需要重新下载。"
if [ "${1:-}" != --no-pause ]; then read -r -p "按 Enter 关闭…"; fi
