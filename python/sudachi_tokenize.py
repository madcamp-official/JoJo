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


# OCR 인식 결과(특히 Yomitoku)에 아주 가끔 깨진(짝이 안 맞는, lone surrogate) 유니코드
# 문자가 섞여 나온다(ocr_yomitoku.py/ocr_paddle.py 와 동일한 문제 — 원인 불명, 인식
# 모델/사전 내부 디코딩 문제로 보임). 이 문자는 형태소 분석 입력(text)이나 SudachiDict
# 자체의 표기/읽기 결과(surface/baseForm)를 통해 여기까지 흘러들 수 있는데, UTF-8 로
# 인코딩이 안 돼서 그대로 두면 아래 serve() 의 print(json.dumps(...)) 자체가 예외를
# 던지고, 그 예외를 잡아 에러 응답을 만들려는 json.dumps({"error": ...}) 조차 같은
# 이유로 또 실패해 서버 프로세스가 죽어버린다(실사용 중 "텍스트 상자가 아예 안 뜸"으로
# 확인). UTF-8 로 왕복 인코딩/디코딩해서 이런 문자를 조용히 제거한다.
def _strip_lone_surrogates(text: str) -> str:
    return text.encode("utf-8", "ignore").decode("utf-8")


def tokenize(text: str, mode: str) -> list[dict]:
    split_mode = MODE_MAP.get(mode, SplitMode.B)
    tokens = []
    for m in get_tokenizer().tokenize(text, split_mode):
        pos = m.part_of_speech()
        tokens.append(
            {
                "surface": _strip_lone_surrogates(m.surface()),
                "pos": pos[0],
                "posDetail1": pos[1],
                "baseForm": _strip_lone_surrogates(m.normalized_form()),
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
            tokens = tokenize(_strip_lone_surrogates(req["text"]), req.get("mode", "B"))
            print(json.dumps({"tokens": tokens}, ensure_ascii=False), flush=True)
        except Exception as e:
            # 에러 메시지 자체에 깨진 문자가 섞여 있으면 이 print 마저 실패해 서버 프로세스가
            # 죽는다(ocr_paddle.py 와 동일한 이중 안전장치).
            print(json.dumps({"error": _strip_lone_surrogates(str(e))}), flush=True)


if __name__ == "__main__":
    serve()
