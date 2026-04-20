#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-./models}"
MODEL_FILE="Phi-3-mini-4k-instruct-q4.gguf"
MODEL_URL="https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf?download=true"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
  echo "Model already exists: $MODEL_DIR/$MODEL_FILE"
  exit 0
fi

echo "Downloading model to $MODEL_DIR/$MODEL_FILE ..."
curl -L -C - -o "$MODEL_DIR/$MODEL_FILE" "$MODEL_URL"

echo "Done."
