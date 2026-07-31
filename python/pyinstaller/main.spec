# -*- mode: python ; coding: utf-8 -*-
# 공용 venv(python/.venv) 4개 스크립트를 하나의 onedir 배포판(nuance-py-main)으로 묶는다.
#
# 왜 하나로 묶는가 — layout_detect.py(doclayout_yolo→torch, paddleocr→paddle 동시 사용),
# ocr_paddle.py(paddle), ocr_yomitoku.py(yomitoku→torch)가 같은 무거운 라이브러리를
# 공유한다. PyInstaller MERGE()로 하나의 COLLECT에 묶지 않으면 torch(약 530MB)·
# paddle(약 430MB)·cv2(약 220MB)가 스크립트마다 중복 포함돼 용량이 몇 배로 는다
# (scripts/build-python-engines.sh, README "다운로드 및 실행" 절 참고).
#
# 실행: scripts/build-python-engines.sh 가 각 venv의 python -m PyInstaller 로 이 스펙을
# 돌린다(로컬 개발에서는 불필요 — venv를 직접 쓰면 됨).
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).resolve().parent  # python/

# 각 스크립트가 직접/간접으로 쓰는 무거운 패키지 — collect_all 로 데이터·바이너리·
# 서브모듈을 통째로 모은다(그렇지 않으면 torch/paddle/cv2 계열은 동적 로딩되는
# .so/.pyd, 모델 config yaml 등이 정적 분석만으로는 안 잡혀 런타임에 ImportError/
# FileNotFoundError로 죽는 게 PyInstaller + ML 프레임워크 조합의 흔한 실패 패턴이다).
COLLECT_ALL_PKGS = [
    'torch',
    'torchvision',
    'paddle',
    'paddleocr',
    'paddlex',
    'cv2',
    'doclayout_yolo',
    'yomitoku',
    'sudachipy',
    'sudachidict_core',
    'huggingface_hub',
]

datas = []
binaries = []
hiddenimports = []
for pkg in COLLECT_ALL_PKGS:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h


def make_analysis(script_name):
    return Analysis(
        [str(ROOT / script_name)],
        pathex=[str(ROOT)],
        binaries=list(binaries),
        datas=list(datas),
        hiddenimports=list(hiddenimports),
        hookspath=[],
        excludes=['matplotlib', 'pandas', 'modelscope', 'reportlab'],  # 스크립트가 실제로 쓰지 않는 무거운 부수 의존성 — 딸려오면 --exclude-module 로 잘라낸다. 빌드가 이들 없이 실패하면(전이 의존으로 진짜 필요하면) 이 목록에서 빼고 다시 빌드할 것.
        noarchive=False,
    )


a_layout = make_analysis('layout_detect.py')
a_paddle = make_analysis('ocr_paddle.py')
a_yomitoku = make_analysis('ocr_yomitoku.py')
a_sudachi = make_analysis('sudachi_tokenize.py')

# 서로 다른 Analysis끼리 겹치는 모듈을 하나로 합쳐 COLLECT 단계에서 중복 저장을 피한다
# (PyInstaller 공식 "Multipackage bundles" 레시피).
MERGE(
    (a_layout, 'layout_detect', 'layout_detect'),
    (a_paddle, 'ocr_paddle', 'ocr_paddle'),
    (a_yomitoku, 'ocr_yomitoku', 'ocr_yomitoku'),
    (a_sudachi, 'sudachi_tokenize', 'sudachi_tokenize'),
)


def make_exe(analysis, name):
    pyz = PYZ(analysis.pure, analysis.zipped_data)
    return EXE(
        pyz,
        analysis.scripts,
        [],
        exclude_binaries=True,
        name=name,
        console=True,  # 표준입출력으로 통신하는 상주 서버라 콘솔(파이프) 모드 필수
    )


exe_layout = make_exe(a_layout, 'layout_detect')
exe_paddle = make_exe(a_paddle, 'ocr_paddle')
exe_yomitoku = make_exe(a_yomitoku, 'ocr_yomitoku')
exe_sudachi = make_exe(a_sudachi, 'sudachi_tokenize')

COLLECT(
    exe_layout, a_layout.binaries, a_layout.zipfiles, a_layout.datas,
    exe_paddle, a_paddle.binaries, a_paddle.zipfiles, a_paddle.datas,
    exe_yomitoku, a_yomitoku.binaries, a_yomitoku.zipfiles, a_yomitoku.datas,
    exe_sudachi, a_sudachi.binaries, a_sudachi.zipfiles, a_sudachi.datas,
    strip=False,
    upx=False,  # UPX 압축은 torch/paddle 의 거대 .so/.dll에서 압축 해제 오버헤드만 늘리고 실패 사례도 많아 끔
    name='nuance-py-main',
)
