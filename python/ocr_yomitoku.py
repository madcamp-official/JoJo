"""담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.

Yomitoku 로 세로쓰기 일본어(ja) 텍스트를 검출+인식한다. PaddleOCR(ocr_paddle.py)
로는 실사용 중 (1) 縦中横 압축 숫자 오독("16"→"10"), (2) 、같은 문장부호가 인식
결과에서 통째로 빠짐, (3) 긴 줄이 "有" 한 글자로 뭉개지는 등 인식 정확도 문제가
반복 확인됐다 — Yomitoku(일본어 특화 OCR)로 같은 페이지를 실측 비교한 결과 이
세 문제가 전부 사라졌다(직접 확인: 같은 크롭에서 정확한 "16", 、/。 전부 보존,
뭉개졌던 줄도 완전한 문장으로 복원됨). 소요 시간도 비슷한 수준(약 19초, 기존
PaddleOCR medium 경로와 대등)이라 인식 백엔드로 교체한다.

PaddleOCR 과 결정적으로 다른 점: PaddleOCR 은 "검출은 줄 단위, 인식은 글자/조각
단위"로 나뉘어 있어 ocrPaddle.ts 가 줄마다 다시 검출을 돌리고(detectLinesWithPaddle)
그 줄 안에서 개별 인식 결과를 격자에 끼워 맞추는 식이었는데, Yomitoku 는 검출과
인식이 한 모델 안에서 통째로 이뤄져서 **줄(컬럼) 하나 = WordPrediction 하나**로
나온다(글자 단위 세부 bbox 없음, 대신 그 줄 전체 텍스트가 통째로 정확함). 그래서
여기서는 줄 검출/인식을 분리하지 않고 한 번의 `OCR()` 호출로 크롭 영역 안의 모든
줄을 통째로 받아 그대로 반환한다 — 줄 순서 재정렬(오른쪽 열부터, 열 안에서는
위→아래)과 후리가나 제외, 격자 기반 단어 분할은 Node 쪽(ocrYomitoku.ts)이
PaddleOCR 경로와 동일한 로직(clusterVerticalLinesIntoColumns/excludeFurigana/
groupCjkCharsGrid, ocrPaddle.ts)을 그대로 재사용한다.

layout_detect.py/ocr_paddle.py 와 같은 상주 서버 패턴(표준입출력, 한 줄 = 요청/
응답 하나)이다 — 모델 로딩이 몇 초 걸려서(첫 인스턴스화 시 HuggingFace Hub 에서
가중치 자동 다운로드, 이후엔 로컬 캐시) 재사용이 필수다.
"""

import json
import sys

import cv2
from yomitoku import OCR

_ocr: OCR | None = None


def get_ocr() -> OCR:
    global _ocr
    if _ocr is None:
        # device='cuda' 가 기본값인데, 이 개발 환경은 GPU 를 전제하지 않으므로(다른
        # python/*.py 전부 CPU 로만 돌림) 명시적으로 cpu 로 고정한다.
        _ocr = OCR(configs={}, device="cpu", visualize=False)
    return _ocr


# Yomitoku 인식 결과에도 PaddleOCR 때와 같은 이유로(원인 불명, 인식 모델/사전 내부
# 디코딩 문제로 보임) 아주 가끔 깨진(짝이 안 맞는, lone surrogate) 유니코드 문자가
# 섞여 나온다(실사용 중 확인 — "텍스트 상자가 아예 안 뜸" + Node 쪽
# UnicodeEncodeError 로그로 재현). 이런 문자는 UTF-8 로 인코딩이 안 돼서 그대로 두면
# 아래 serve() 의 print(json.dumps(...)) 자체가 예외를 던지고, 그 예외를 잡아 에러
# 응답을 만들려는 json.dumps({"error": ...}) 조차 같은 이유로 또 실패해 서버 프로세스가
# 죽어버린다. UTF-8 로 왕복 인코딩/디코딩해서 이런 문자를 조용히 제거한다
# (ocr_paddle.py 의 _strip_lone_surrogates 와 동일).
def _strip_lone_surrogates(text: str) -> str:
    return text.encode("utf-8", "ignore").decode("utf-8")


def recognize_lines(image_path: str) -> list[dict]:
    img = cv2.imread(image_path)
    ocr = get_ocr()
    results, _ = ocr(img)
    lines = []
    for w in results.words:
        text = _strip_lone_surrogates((w.content or "").strip())
        if not text:
            continue
        xs = [float(p[0]) for p in w.points]
        ys = [float(p[1]) for p in w.points]
        lines.append(
            {
                "text": text,
                "x0": min(xs),
                "y0": min(ys),
                "x1": max(xs),
                "y1": max(ys),
                "direction": w.direction,
                "rec_score": float(w.rec_score),
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
            # 에러 메시지 자체에 깨진 문자가 섞여 있으면 이 print 마저 실패해 서버 프로세스가
            # 죽는다(ocr_paddle.py 와 동일한 이중 안전장치).
            print(json.dumps({"error": _strip_lone_surrogates(str(e))}), flush=True)


if __name__ == "__main__":
    serve()
