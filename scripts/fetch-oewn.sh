#!/usr/bin/env bash
# OEWN(Open English WordNet) 번들(resources/oewn/*.json)을 내려받고 build-oewn-bundle.py로
# 병합한다 — README.md "사전 데이터 준비"에 있던 수동 curl/unzip/python 절차를 그대로
# 스크립트로 옮긴 것. scripts/ensure-resources.sh 가 이 파일이 없을 때 자동 호출한다.
#
# 다운로드 경로 근거(DICTIONARY_SOURCES.md#oewn 참고): 공식 GitHub Releases(2025-edition),
# 실측 확인(2026-07-28) HTTP 200/9.98MB.

set -euo pipefail

cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -L -o "$tmp/oewn.zip" \
  https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip
mkdir "$tmp/oewn"
unzip -q "$tmp/oewn.zip" -d "$tmp/oewn"
python3 scripts/build-oewn-bundle.py "$tmp/oewn"
