"""일본어 형태소 분석 — Sudachi 백엔드(main/nlp/engines/sudachi.ts 전용).

layout_detect.py/ocr_paddle.py 와 동일한 상주 서버 패턴(표준입출력, 한 줄 = 요청/응답
하나) — SudachiDict 로딩 비용을 매 호출마다 물지 않기 위함이다. mode(A/B/C)는 요청마다
받되, 실제로는 main/nlp/engines/sudachi.ts 가 항상 같은 값(JA_ENGINE 설정)을 보낸다.

토큰의 pos/posDetail1/baseForm 필드명은 IPADIC 엔진(kuromoji/lindera)과 맞춰서 노출한다
(main/nlp/japanese.ts 가 엔진 무관하게 같은 JaToken 셰이프로 받기 위함) — 실제 값 체계는
UniDic 이라 shared/nlp/ja-unidic.ts 가 이걸 해석한다.
"""

import json
import sys

from sudachipy import Dictionary, SplitMode

_tokenizer = None

MODE_MAP = {"A": SplitMode.A, "B": SplitMode.B, "C": SplitMode.C}


def get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        _tokenizer = Dictionary().create()
    return _tokenizer


def tokenize(text: str, mode: str) -> list[dict]:
    split_mode = MODE_MAP.get(mode, SplitMode.B)
    tokens = []
    for m in get_tokenizer().tokenize(text, split_mode):
        pos = m.part_of_speech()
        tokens.append(
            {
                "surface": m.surface(),
                "pos": pos[0],
                "posDetail1": pos[1],
                "baseForm": m.normalized_form(),
                "start": m.begin(),
            }
        )
    return tokens


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            tokens = tokenize(req["text"], req.get("mode", "B"))
            print(json.dumps({"tokens": tokens}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    serve()
