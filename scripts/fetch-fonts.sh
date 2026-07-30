#!/usr/bin/env bash
# 한중일영 통일 폰트(src/renderer/src/assets/fonts/*.ttf)를 내려받는다.
#
# 이 파일들은 재생성 가능한 자산이라 저장소에 커밋하지 않는다(.gitignore 처리,
# 2026-07-30). 새로 clone 했거나 갱신이 필요할 때 이 스크립트를 실행한다:
#
#     bash scripts/fetch-fonts.sh
#
# google/fonts 저장소(OFL 라이선스)의 가변 폰트(wght 100~900 한 파일에 전부 포함) 원본을
# 그대로 받는다 — 언어별로 정적 웨이트 파일을 여러 개 받는 대신 파일 하나로 400/500/600/700
# 등 필요한 모든 굵기를 커버한다. woff2로 재압축하지 않고 ttf 원본을 그대로 쓰는 이유는
# 이 프로젝트가 웹이 아니라 Electron(Chromium 내장)만 대상이라 포맷 호환을 신경 쓸 필요가
# 없고, 무엇보다 압축 변환에 fonttools(Python) 의존성이 추가로 필요해져 팀원 전원이
# 설치해야 하는 부담이 생기기 때문 — curl만으로 끝나는 쪽을 택했다(resources/ 사전 데이터와
# 같은 원칙: 다운로드 스크립트는 최대한 의존성 없이 동작해야 한다).
#
# 중국어는 간체(SC)/번체(TC) 자형이 같은 유니코드 코드포인트라도 다르게 그려져야 해서
# (한자통합, Han Unification) 두 파일을 각각 받는다 — 하나로 퉁치면 번체 텍스트가 간체
# 자형으로 보이는 문제가 생긴다.

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="src/renderer/src/assets/fonts"
mkdir -p "$OUT_DIR"

BASE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl"

fetch_one() {
  local family_dir="$1" file_name="$2" out_name="$3"
  local url="${BASE_URL}/${family_dir}/${file_name}"
  echo "받는 중: $out_name"
  curl -sL --fail -o "$OUT_DIR/$out_name" "$url"
}

fetch_one "notosanskr" "NotoSansKR%5Bwght%5D.ttf" "NotoSansKR-Variable.ttf"
fetch_one "notosansjp" "NotoSansJP%5Bwght%5D.ttf" "NotoSansJP-Variable.ttf"
fetch_one "notosanssc" "NotoSansSC%5Bwght%5D.ttf" "NotoSansSC-Variable.ttf"
fetch_one "notosanstc" "NotoSansTC%5Bwght%5D.ttf" "NotoSansTC-Variable.ttf"

echo "폰트 다운로드 완료: $OUT_DIR"
