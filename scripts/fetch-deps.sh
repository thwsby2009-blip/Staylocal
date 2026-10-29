#!/usr/bin/env bash
# 下載不進版控的原生相依（大檔）
#
# sherpa-onnx AAR：離線語音辨識（SenseVoice）推論用，約 49MB，
# 放置於 android/app/libs/。版本必須與 android/app/build.gradle 的
#   implementation files('libs/sherpa-onnx-<VERSION>.aar')
# 一致，改版時兩邊一起改。
#
# 用法：bash scripts/fetch-deps.sh
set -euo pipefail

VERSION="2.0.1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/android/app/libs"
FILE="$DEST/sherpa-onnx-${VERSION}.aar"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-${VERSION}.aar"

mkdir -p "$DEST"
if [ -f "$FILE" ]; then
  echo "已存在，略過下載：$FILE"
  exit 0
fi

echo "下載 sherpa-onnx ${VERSION} AAR（約 49MB）…"
curl -L --fail -o "$FILE" "$URL"
echo "完成：$FILE"
