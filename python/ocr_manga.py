"""담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.

manga-ocr(kha-white/manga-ocr-base)로 세로쓰기 일본어(망가 등)를 인식한다.
PaddleOCR 은 검출+인식을 같이 하지만, manga-ocr 은 인식 전용 모델이라(입력 크롭
하나 → 텍스트 문자열 하나, bbox 없음) 줄 위치는 PaddleOCR 의 detect_lines
모드(ocr_paddle.py)로 먼저 잡고, 그 크롭을 여기로 넘겨 텍스트만 받는다. 글자 단위
박스는 Node(ocrManga.ts) 가 그 줄 bbox 를 글자 수 비율로 나눠서 만든다 — 라틴
문자와 달리 한자/가나는 폭이 거의 균일(정사각형 그리드에 가까움)해서 개수 비율
분배가 라틴 단어 때보다 훨씬 안전하다(실측: "officials" 같은 라틴 단어는 개수
비율로 나누면 최대 15px 어긋났었음 — ocr.ts: padRect 주석 참고).

layout_detect.py/ocr_paddle.py 와 같은 상주 서버 패턴(표준입출력, 줄 단위 요청/응답).
"""

import json
import sys

from manga_ocr import MangaOcr

_mocr: MangaOcr | None = None


def get_mocr() -> MangaOcr:
    global _mocr
    if _mocr is None:
        _mocr = MangaOcr()
    return _mocr


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = get_mocr()(req["image_path"])
            print(json.dumps({"text": text}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    serve()
