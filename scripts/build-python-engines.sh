#!/usr/bin/env bash
# CI 전용 — python/.venv, python/.venv-ndlocr-test 를 PyInstaller로 배포용 실행 파일로
# 굳힌다(freeze). 로컬 개발에서는 쓸 필요 없다(venv를 직접 쓰면 되므로) — 릴리스 워크플로
# (.github/workflows/release.yml)에서만 실행한다.
#
# 4개 스크립트(layout_detect/ocr_paddle/ocr_yomitoku/sudachi_tokenize)는 같은 venv를
# 공유하고 torch/paddle/cv2 등 무거운 의존성도 겹치므로, pyinstaller/main.spec 에서
# MERGE()로 하나의 onedir 번들(nuance-py-main)로 묶는다 — 따로 freeze하면 같은
# 라이브러리가 몇 배로 중복돼 용량이 폭발한다(README/PLAN 참고).
# ocr_ndlocr.py 는 의존성 충돌 때문에 원래도 격리된 venv를 쓰므로 별도 번들(nuance-py-ndlocr).
set -euo pipefail
cd "$(dirname "$0")/../python"

if [ "${RUNNER_OS:-}" = "Windows" ]; then
  VENV_PY=".venv/Scripts/python.exe"
  NDLOCR_VENV_PY=".venv-ndlocr-test/Scripts/python.exe"
else
  VENV_PY=".venv/bin/python"
  NDLOCR_VENV_PY=".venv-ndlocr-test/bin/python"
fi

if [ ! -x "$VENV_PY" ] && [ ! -f "$VENV_PY" ]; then
  echo "빌드 실패: $VENV_PY 없음 — 먼저 python/README.md 의 공용 venv 설정을 실행하세요." >&2
  exit 1
fi
if [ ! -x "$NDLOCR_VENV_PY" ] && [ ! -f "$NDLOCR_VENV_PY" ]; then
  echo "빌드 실패: $NDLOCR_VENV_PY 없음 — 먼저 python/README.md 의 NDLOCR-Lite venv 설정을 실행하세요." >&2
  exit 1
fi

echo "== 공용 번들(layout_detect/ocr_paddle/ocr_yomitoku/sudachi_tokenize) 빌드 =="
"$VENV_PY" -m pip install --quiet --upgrade pyinstaller
"$VENV_PY" -m PyInstaller pyinstaller/main.spec --distpath dist-py --workpath build-py --noconfirm

echo "== NDLOCR 번들 빌드 =="
"$NDLOCR_VENV_PY" -m pip install --quiet --upgrade pyinstaller
"$NDLOCR_VENV_PY" -m PyInstaller pyinstaller/ndlocr.spec --distpath dist-py-ndlocr --workpath build-py-ndlocr --noconfirm

echo "빌드 완료: python/dist-py/nuance-py-main/, python/dist-py-ndlocr/nuance-py-ndlocr/"
