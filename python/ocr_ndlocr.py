"""담당 A — 실험용 브랜치(experiment/ndlocr-lite) 전용.

NDLOCR-Lite(정확히는 "NDLkotenOCR-Lite" — 일본 국립국회도서관이 옛 일본어 고문서
용으로 만든 검출+인식 모델, https://github.com/ndl-lab/ndlocr-lite)로 세로쓰기
일본어를 인식해본다. Yomitoku(ocr_yomitoku.py)의 대안으로 시도 — 실측 확인 결과
(sarashina 테스트 이미지, 라이트노벨 세로쓰기 페이지) 본문 인식 신뢰도 0.88~0.93,
문장부호(、。)·대시 보존, 처리 시간 약 4초(Yomitoku 약 19초 대비 훨씬 빠름)로 꽤
쓸만했다. 다만 고문서용 모델이라 현대 인쇄 텍스트가 원래 대상이 아니라는 점,
그리고 縦中横(세로쓰기 안에 가로로 눕힌 숫자, 예: "17") 구간이 --enable-tcy를
켜도 통째로 누락되는 경우를 한 번 확인했다(오인식이 아니라 그 구간 자체가 텍스트
에서 빠짐) — 이 문제는 아직 원인 파악 전.

ocr_yomitoku.py 와 달리 `yomitoku.OCR()` 같은 공개 클래스가 없다 — pip 패키지에
동봉된 `ocr.py`(CLI 스크립트 본체)의 내부 함수를 직접 가져다 쓴다(패키지 저자도
README에서 "ocr.process()는 공개 API가 아니다"라고 명시함 — 나중에 버전이 바뀌면
깨질 수 있음, 그때는 CLI(`ndlocr-lite --sourceimg ... --json-only`) 서브프로세스
호출로 폴백하는 방향도 고려). 여기서는 그중에서도 `_run_ocr_on_image_array`(파일
경로가 아니라 numpy 이미지 배열을 직접 받아 detector+recognizer를 거쳐 줄 단위
JSON을 반환하는 하부 함수)를 쓴다 — CLI(`ocr.process`)처럼 매번 파일을 읽고 결과를
디스크에 다시 쓰는 왕복 없이, 모델 인스턴스(detector/recognizer)만 한 번 로드해두고
(get_ocr() 싱글턴, ocr_yomitoku.py와 동일 패턴) 재사용할 수 있다.

주의: 이 실험 브랜치는 python/.venv(공용)를 안 쓴다 — ndlocr-lite가 numpy/opencv/
onnxruntime 등을 낮은 버전으로 끌어내려 설치하려 해서, 공용 venv에 그대로 설치하면
PaddleOCR/Yomitoku가 요구하는 버전과 충돌한다(실제로 한 번 이 사고가 나서 원복한
적 있음). 대신 `.venv-sarashina-test`와 같은 패턴으로 `python/.venv-ndlocr-test`라는
격리된 venv를 따로 둔다 — pythonServer.ts 가 이 스크립트를 스폰할 때는(ocrNdlocr.ts)
공용 PYTHON_BIN 대신 이 venv의 인터프리터를 쓴다(createPythonServer 의 pythonBin
오버라이드 인자).
"""

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import cv2

# Electron 이 콘솔 없이 스폰하는 자식 프로세스라 Python 이 stdout/stderr 인코딩을
# 시스템 로캘(한국어 Windows 는 cp949)로 잡는다 — NDLOCR-lite 내부(로깅 등, 정확한
# 지점은 미확인)가 인식된 CJK 문자(예: "号")를 그 인코딩으로 쓰려다
# UnicodeEncodeError 로 터지는 걸 실측 확인(우리 쪽 print(json.dumps(...))는
# ensure_ascii=True 라 원래 안전한데도 이 에러가 남 — 즉 우리 코드 밖의 print/log
# 호출이 원인). 인코딩을 UTF-8로 못박아 근본 원인을 없앤다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

_default_site_packages = Path(__file__).resolve().parent / ".venv-ndlocr-test" / "Lib" / "site-packages"
_site_packages = os.environ.get("NDLOCR_SITE_PACKAGES", str(_default_site_packages))
sys.path.insert(0, _site_packages)

import ocr as ndlocr  # noqa: E402  (패키지 저자가 공개 API로 보장하지 않는 내부 모듈)

_state: dict | None = None


def _default_args() -> SimpleNamespace:
    base_dir = Path(ndlocr.__file__).resolve().parent
    return SimpleNamespace(
        device="cpu",
        det_weights=str(base_dir / "model" / "deim-s-1024x1024.onnx"),
        det_classes=str(base_dir / "config" / "ndl.yaml"),
        det_score_threshold=0.2,
        det_conf_threshold=0.25,
        det_iou_threshold=0.2,
        rec_weights=str(base_dir / "model" / "parseq-ndl-24x768-100-tiny-153epoch-tegaki3-r8data-202604.onnx"),
        rec_weights30=str(base_dir / "model" / "parseq-ndl-24x256-30-tiny-189epoch-tegaki3-r8data-202604.onnx"),
        rec_weights50=str(base_dir / "model" / "parseq-ndl-24x384-50-tiny-300epoch-tegaki3-r8data-202604.onnx"),
        rec_classes=str(base_dir / "config" / "NDLmoji.yaml"),
        # CLI 기본값(--enable-tcy 없이 실행)과 다르게 여기서는 항상 켠다 — 세로쓰기
        # 숫자(縦中横)를 다루는 게 애초에 이 실험의 목적 중 하나라서.
        enable_tcy=True,
    )


def get_state() -> dict:
    global _state
    if _state is None:
        args = _default_args()
        _state = {
            "detector": ndlocr.get_detector(args),
            "recognizer100": ndlocr.get_recognizer(args=args),
            "recognizer30": ndlocr.get_recognizer(args=args, weights_path=args.rec_weights30),
            "recognizer50": ndlocr.get_recognizer(args=args, weights_path=args.rec_weights50),
        }
    return _state


# ocr_yomitoku.py/ocr_paddle.py 와 같은 이유(짝이 안 맞는 유니코드 문자가 아주 가끔
# 섞여 나와 print(json.dumps(...))가 죽는 문제)로 동일하게 방어.
def _strip_lone_surrogates(text: str) -> str:
    return text.encode("utf-8", "ignore").decode("utf-8")


def recognize_lines(image_path: str) -> list[dict]:
    state = get_state()
    img = cv2.imread(image_path)
    result = ndlocr._run_ocr_on_image_array(
        detector=state["detector"],
        recognizer30=state["recognizer30"],
        recognizer50=state["recognizer50"],
        recognizer100=state["recognizer100"],
        inputname=Path(image_path).name,
        img=cv2.cvtColor(img, cv2.COLOR_BGR2RGB),
        outputpath="",
        save_viz=False,
    )
    lines = []
    for line in result["json_lines"]:
        text = _strip_lone_surrogates((line["text"] or "").strip())
        if not text:
            continue
        (x0, y0), _, (x1, _), (_, y1) = line["boundingBox"]
        lines.append(
            {
                "text": text,
                "x0": float(x0),
                "y0": float(y0),
                "x1": float(x1),
                "y1": float(y1),
                "direction": "vertical" if line["isVertical"] == "true" else "horizontal",
                "rec_score": float(line["confidence"]),
            }
        )
    return lines


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            lines = recognize_lines(req["image_path"])
            print(json.dumps({"lines": lines}), flush=True)
        except Exception as e:
            print(json.dumps({"error": _strip_lone_surrogates(str(e))}), flush=True)


if __name__ == "__main__":
    serve()
