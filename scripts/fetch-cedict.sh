#!/usr/bin/env bash
# CC-CEDICT 원본 파일(resources/cedict.u8)을 내려받는다.
#
# resources/cedict.u8 은 재생성 가능한 데이터라 저장소에 커밋하지 않는다(.gitignore 처리,
# 2026-07-28). 새로 clone 했거나 갱신이 필요할 때 이 스크립트를 실행한다:
#
#     bash scripts/fetch-cedict.sh
#
# 다운로드 경로 실측 확인(2026-07-28): MDBG 공식 배포 URL
# https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz (HTTP 200,
# gzip, 약 4MB) — cc-cedict.org/download/ 경로는 404, 이 MDBG export 경로만 확인됨.
# 압축 해제하면 저장소에 있던 resources/cedict.u8 과 헤더(라이선스 주석)까지 바이트 단위로
# 동일 — 변환 없이 그대로 사용한다(어댑터가 파일명을 resources/cedict.u8 로 참조).

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p resources
curl -L -o /tmp/cedict.gz \
  https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
gunzip -c /tmp/cedict.gz > resources/cedict.u8
rm /tmp/cedict.gz
echo "resources/cedict.u8 다운로드 완료: $(wc -l < resources/cedict.u8) 줄"
