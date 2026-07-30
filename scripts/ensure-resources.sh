#!/usr/bin/env bash
# resources/(로컬 사전 번들, .gitignore 처리됨)가 없으면 빌드/개발 서버 실행 전에 자동으로
# 채운다. package.json의 predev/prebuild 훅에서 호출한다 — 각 fetch-*.sh는 이미 있으면
# 다시 받지 않고 건너뛴다(멱등).

set -euo pipefail

cd "$(dirname "$0")/.."

need_fetch=0

if [ ! -s resources/cedict.u8 ]; then
  echo "resources/cedict.u8 없음 — CC-CEDICT 다운로드"
  bash scripts/fetch-cedict.sh
  need_fetch=1
fi

if [ ! -s resources/oewn/entries.json ] || [ ! -s resources/oewn/synsets.json ]; then
  echo "resources/oewn/*.json 없음 — OEWN 다운로드+빌드"
  bash scripts/fetch-oewn.sh
  need_fetch=1
fi

if [ ! -s resources/jmdict/words.json ] || [ ! -s resources/jmdict/index.json ] || [ ! -s resources/jmdict/tags.json ]; then
  echo "resources/jmdict/*.json 없음 — JMdict 다운로드+빌드"
  bash scripts/fetch-jmdict.sh
  need_fetch=1
fi

FONT_DIR="src/renderer/src/assets/fonts"
if [ ! -s "$FONT_DIR/NotoSansKR-Variable.ttf" ] || [ ! -s "$FONT_DIR/NotoSansJP-Variable.ttf" ] ||
   [ ! -s "$FONT_DIR/NotoSansSC-Variable.ttf" ] || [ ! -s "$FONT_DIR/NotoSansTC-Variable.ttf" ]; then
  echo "$FONT_DIR/*.ttf 없음 — 한중일영 통일 폰트(Noto Sans) 다운로드"
  bash scripts/fetch-fonts.sh
  need_fetch=1
fi

if [ "$need_fetch" -eq 0 ]; then
  echo "resources/ 이미 준비됨 — 건너뜀"
fi
