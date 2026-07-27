"""담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.

PaddleOCR로 en/zh/ja(가로쓰기) 텍스트를 검출+인식한다. Tesseract 대신 쓰는 이유는
TODO.md/대화 기록 참고 — 특히 일본어 스캔 파일에서 Tesseract 인식률이 낮았다.

layout_detect.py 와 같은 상주 서버 패턴이다(표준입출력, 한 줄 = 요청/응답 하나) —
매번 새 프로세스를 띄우면 PaddleX/PaddlePaddle 모델 로딩만 몇 초~수십 초 걸려서
(실측: layout_detect.py 도 같은 이유로 8초+ 걸렸었음) 재사용이 필수다.

이미지는 Node(ocrPaddle.ts) 가 미리 크롭해서 넘긴다(Tesseract 의 rectangle 옵션 같은
게 PaddleOCR 엔 없어서) — 그래서 여기 요청엔 region 이 없고, 응답 bbox 는 그 크롭
이미지 기준 상대좌표다(Node 가 크롭 원점을 더해 절대좌표로 되돌림).

핵심은 `return_word_box=True` — PaddleOCR 이 글자/단어 단위 실제 bbox 를 직접 준다
(줄 단위 박스를 글자 수 비율로 추정하던 우리 예전 방식보다 훨씬 정확 — 실측 확인:
"officials" 같은 단어를 글자 개수로 나누면 최대 15px 어긋났는데, PaddleOCR 은 그
어긋남 자체가 없음). 공백 토큰(`' '`)은 클릭 대상이 아니므로 걸러낸다.
"""

import json
import sys

from paddleocr import PaddleOCR

# 우리 Language 타입(en/ja/zh) → PaddleOCR lang 코드. 일본어는 'japan'(ja 아님),
# 중국어는 'ch'(zh 아님) — PaddleOCR 고유 코드라 헷갈리기 쉬워서 주석으로 명시.
LANG_MAP = {"en": "en", "ja": "japan", "zh": "ch"}

_engines: dict[str, PaddleOCR] = {}


def get_engine(language: str) -> PaddleOCR:
    paddle_lang = LANG_MAP.get(language, "en")
    if paddle_lang not in _engines:
        # enable_mkldnn=False 필수 — 켜두면(기본값) 이 환경에서 oneDNN 실행기가
        # "ConvertPirAttribute2RuntimeAttribute not support" 로 매번 죽었다(실측 확인,
        # PaddlePaddle/oneDNN 조합 버그로 보임). 문서 방향 보정도 꺼서(스크린샷은 항상
        # 똑바로 서 있으므로 불필요) 조금이라도 더 빠르게 한다.
        _engines[paddle_lang] = PaddleOCR(
            lang=paddle_lang,
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
        )
    return _engines[paddle_lang]


def detect_lines(image_path: str, language: str) -> list[dict]:
    """줄 단위 박스만 필요할 때(세로쓰기 일본어 → manga-ocr 조합, ocrManga.ts 참고) —
    PaddleOCR 자체 인식 텍스트(rec_texts)는 세로쓰기에 최적화돼있지 않아 품질을 못
    믿으므로 버리고, 검출 박스(rec_boxes, 줄 단위 axis-aligned bbox)만 쓴다. 실제 텍스트는
    이 박스로 크롭한 이미지를 manga-ocr 에 따로 넘겨서 얻는다."""
    engine = get_engine(language)
    results = engine.predict(image_path)
    lines = []
    for r in results:
        boxes = r.get("rec_boxes")
        if boxes is None:
            continue
        for b in boxes.tolist():
            x0, y0, x1, y1 = b
            lines.append({"x0": float(x0), "y0": float(y0), "x1": float(x1), "y1": float(y1)})
    return lines


def recognize(image_path: str, language: str) -> list[dict]:
    engine = get_engine(language)
    results = engine.predict(image_path, return_word_box=True)
    words = []
    for r in results:
        text_word = r.get("text_word") or []
        text_word_boxes = r.get("text_word_boxes")
        if text_word_boxes is None:
            continue
        for line_words, line_boxes in zip(text_word, text_word_boxes):
            for w, b in zip(line_words, line_boxes.tolist()):
                if not w.strip():  # 공백 토큰은 클릭 대상이 아니므로 제외
                    continue
                x0, y0, x1, y1 = b
                words.append({"text": w, "x0": float(x0), "y0": float(y0), "x1": float(x1), "y1": float(y1)})
    return words


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("mode") == "detect_lines":
                lines = detect_lines(req["image_path"], req["language"])
                print(json.dumps({"lines": lines}), flush=True)
            else:
                words = recognize(req["image_path"], req["language"])
                print(json.dumps({"words": words}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    serve()
