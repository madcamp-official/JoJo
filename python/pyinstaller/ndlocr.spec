# -*- mode: python ; coding: utf-8 -*-
# 격리 venv(python/.venv-ndlocr-test)의 ocr_ndlocr.py를 독립 onedir 배포판
# (nuance-py-ndlocr)으로 묶는다. 이 venv는 numpy/opencv/onnxruntime 버전을 공용
# venv와 다르게 고정해서(python/README.md 참고) 원래도 격리돼 있으므로 여기서도
# main.spec과 따로 빌드한다 — torch/paddle이 없어(onnxruntime 기반) main 번들보다
# 훨씬 작다.
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).resolve().parent  # python/

COLLECT_ALL_PKGS = ['cv2', 'onnxruntime', 'model']  # 'model' = deim/parseq onnx 가중치를 담은 패키지(__init__.py 있음)

datas = []
binaries = []
hiddenimports = ['ocr', 'ndl_parser']  # site-packages 최상위에 flat 모듈로 설치돼 있어(패키지 아님) collect_all 대상이 아니라 명시적으로 추가
for pkg in COLLECT_ALL_PKGS:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [str(ROOT / 'ocr_ndlocr.py')],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=['reportlab', 'flet', 'pypdf', 'pypdfium2_raw'],  # ndlocr_lite pip 패키지가 CLI 부가기능(PDF 출력, GUI 데모)용으로 끌고 오지만 ocr_ndlocr.py는 안 씀 — 실제로 필요하면(임포트 에러 나면) 이 목록에서 빼고 재빌드
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ocr_ndlocr', console=True)
COLLECT(exe, a.binaries, a.zipfiles, a.datas, strip=False, upx=False, name='nuance-py-ndlocr')
