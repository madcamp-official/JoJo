"""담당 A — 가로쓰기 일본어 후리가나 노이즈 문제 대응(2026-07-29).

**검출 전용**(인식은 안 함) — Yomitoku(일본어 특화 OCR)의 `TextDetector`로 가로쓰기
일본어 줄 위치만 찾는다. PaddleOCR(ocr_paddle.py) 가로쓰기 경로는 후리가나(루비
문자)가 페이지에 따라 본문 한자와 아예 하나의 검출 박스로 합쳐져 나오는 경우가
있어(사용자 실측 확인: 검출된 줄의 높이가 후리가나+본문을 합친 만큼 커지고, 인식
결과도 두 줄이 뒤섞여 노이즈가 됨) rect 기반 후리가나 필터(excludeFuriganaHorizontal)
로는 원리적으로 못 잡는 경우가 있다. Yomitoku 는 검출 모델 자체가 달라서(DBNet 이지만
학습 데이터/후처리가 다름), 후리가나를 본문과 분리된 별도 박스로 검출하는 경향이
확인됐다(실측: 같은 페이지에서 후리가나 텍스트 박스가 안 뜨고 팝업 노이즈도 사라짐).

**처음엔 Yomitoku 의 `OCR`(검출+인식 통합) 클래스를 그대로 썼는데, 인식 단계가
병목이었다**(실측: 검출 4.7초 vs 인식 44.8초 — Yomitoku 인식은 우리 워커 풀 없이
단일 프로세스에서 모든 줄을 순차 처리해서 느림). 실제 텍스트 인식은 이미 워커 풀로
병렬화돼 있고 충분히 빠른 PaddleOCR(ocr_paddle.py)에 맡기고, 여기서는 후리가나를
정확히 분리해내는 검출 결과(줄 위치)만 제공한다 — `TextDetector`(검출 전용 클래스)
만 로드해서 인식 모델 자체를 아예 안 돌린다(ocr_paddle.py 의 `TextDetection` 전용
경로와 같은 이유·같은 패턴).

**세로쓰기에는 적용하지 않는다** — 세로쓰기는 이미 검증된 NDLOCR-Lite(+PaddleOCR
보조) 조합을 쓰고 있고(ocrNdlocr.ts), 이 파일은 가로쓰기 전용 노이즈 문제 대응이
목적이라 세로쓰기 경로(ocr.ts: runVerticalOcr)에는 연결하지 않는다. 방향(가로/세로)
구분 자체도 이 검출 전용 클래스는 안 주므로(Yomitoku 의 `direction` 필드는 인식
단계에서 나옴) 이 서버는 항상 "이미 가로쓰기로 판별된 크롭"에 대해서만 호출된다는
전제로 동작한다 — 호출부(ocrYomitoku.ts)가 그 전제를 지킨다.

layout_detect.py/ocr_paddle.py 와 같은 상주 서버 패턴(표준입출력, 한 줄 = 요청/
응답 하나)이다.
"""

import json
import sys

import cv2
from yomitoku.text_detector import TextDetector

_detector: TextDetector | None = None


def get_detector() -> TextDetector:
    global _detector
    if _detector is None:
        # device='cuda' 가 기본값인데, 이 개발 환경은 GPU 를 전제하지 않으므로(다른
        # python/*.py 전부 CPU 로만 돌림) 명시적으로 cpu 로 고정한다.
        _detector = TextDetector(device="cpu", visualize=False)
    return _detector


def detect_lines(image_path: str) -> list[dict]:
    img = cv2.imread(image_path)
    detector = get_detector()
    results, _ = detector(img)
    lines = []
    for points, score in zip(results.points, results.scores):
        xs = [float(p[0]) for p in points]
        ys = [float(p[1]) for p in points]
        lines.append({"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys), "score": float(score)})
    return lines


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            lines = detect_lines(req["image_path"])
            print(json.dumps({"lines": lines}), flush=True)
        except Exception as e:
            # 에러 메시지 자체에 깨진 문자가 섞여 있으면 이 print 마저 실패해 서버 프로세스가
            # 죽는다(ocr_paddle.py 의 이중 안전장치와 동일한 이유) — 검출 결과에는 텍스트가
            # 없어(bbox+score 뿐) 원래 이 문제가 안 생기지만, 에러 메시지 자체는 무엇이든
            # 올 수 있어 방어는 유지한다.
            safe_msg = str(e).encode("utf-8", "ignore").decode("utf-8")
            print(json.dumps({"error": safe_msg}), flush=True)


if __name__ == "__main__":
    serve()
