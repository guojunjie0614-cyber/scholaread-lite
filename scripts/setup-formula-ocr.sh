#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
if ! command -v uv >/dev/null 2>&1; then
  echo '需要 uv：https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
if [ ! -x .venv-formula-ocr/bin/python ]; then
  uv venv --python 3.11 .venv-formula-ocr
fi
uv pip install --python .venv-formula-ocr/bin/python -r requirements-formula-ocr.txt
.venv-formula-ocr/bin/python scripts/formula-ocr.py --setup
