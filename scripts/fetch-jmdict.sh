#!/usr/bin/env bash
# JMdict 번들(resources/jmdict/*.json)을 내려받고 build-jmdict-bundle.py로 병합한다 —
# README.md "사전 데이터 준비"에 있던 수동 curl/tar/python 절차를 그대로 스크립트로 옮긴
# 것. scripts/ensure-resources.sh 가 이 파일이 없을 때 자동 호출한다.
#
# jmdict-simplified 릴리스 태그를 고정한다(2026-07-28 기준 최신, GitHub API로 실측 확인) —
# "최신 태그 자동 조회" 대신 고정해야 매번 같은 데이터로 재현 가능하다. 갱신하려면 이 파일의
# TAG 값만 https://github.com/scriptin/jmdict-simplified/releases 최신 태그로 바꾸면 된다.

set -euo pipefail

TAG='3.6.2+20260727141257'
TAG_ENC="${TAG//+/%2B}"
ASSET="jmdict-eng-${TAG_ENC}.json.tgz"

cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -L -o "$tmp/jmdict-eng.json.tgz" \
  "https://github.com/scriptin/jmdict-simplified/releases/download/${TAG_ENC}/${ASSET}"
mkdir "$tmp/jmdict"
tar xzf "$tmp/jmdict-eng.json.tgz" -C "$tmp/jmdict"
python3 scripts/build-jmdict-bundle.py "$tmp/jmdict"/jmdict-eng-*.json
