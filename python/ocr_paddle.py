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

from paddleocr import PaddleOCR, TextDetection

# 우리 Language 타입(en/ja/zh-Hans/zh-Hant) → PaddleOCR lang 코드. 일본어는 'japan'
# (ja 아님) — PaddleOCR 고유 코드라 헷갈리기 쉬워서 주석으로 명시.
#
# (정정) 예전엔 중국어 간체/번체가 서로 다른 전용 인식 모델을 쓴다고 판단해서 각각
# 다른 lang 코드를 매핑했었는데, 직접 확인해보니 이 PaddleOCR 버전에서는 ch/chinese_cht/
# japan/en 네 개 lang 코드 전부 완전히 동일한 모델 파일(PP-OCRv6_medium_det/_rec)을
# 쓰고 있었다 — 언어별 전용 모델은 없고 lang 은 사실상 아무 영향이 없다(그래도 매핑은
# 그대로 두는데, langDetect.ts 가 스크립트 판별해서 넘겨주는 값과 자연스럽게 이어지고
# 나중에 PaddleOCR 가 다시 언어별 모델을 분리하는 경우를 대비할 수 있어서 — 지금은
# 그냥 문서화 목적).
LANG_MAP = {"en": "en", "ja": "japan", "zh-Hans": "ch", "zh-Hant": "chinese_cht"}

_engines: dict[str, PaddleOCR] = {}
_detector: TextDetection | None = None

# 검출은 그대로 medium 을 쓰고(실측 확인: PP-OCRv6_small_det 로 바꾸면 박스 경계가 덜
# 타이트해져서 특정 줄이 심하게 잘리는 문제가 있었음 — "力"으로 통째로 잘린 사례).
# 인식은 한동안 small 로 썼는데(실측 확인: medium 대비 속도 약 30% 빠르면서 대부분
# 정확도는 동등하거나 오히려 더 나았음 — 예: "返っていて" 를 medium 은 틀렸는데 small 은
# 맞음), 세로쓰기 관례로 압축된 작은 숫자(縦中横, 예: "16"을 "10"으로 오독)에서는 small
# 이 더 취약한 사례가 실사용 중 확인돼 medium 으로 되돌려 실측 비교 중.
RECOGNITION_MODEL_NAME = "PP-OCRv6_medium_rec"


# 워커 프로세스를 6개(POOL_SIZE, ocrPaddle.ts)나 띄우는데, 실사용 중 같은 조건(캐시
# 재사용, 예열 완료)으로 반복 실행해도 16.8~25.4초로 편차가 컸던 적이 있어서 "워커별
# 내부 스레드(OpenMP/MKL)까지 겹쳐서 코어를 오버서브스크립션하는 게 원인 아닐까" 의심
# 하고 cpu_threads=1 로 제한해 실측 비교했다 — 그런데 같은 이미지로 통제 비교해보니
# (3회 반복) cpu_threads=1 이 오히려 변동폭이 더 크고(23.8~25.8s) 기본값(제한 없음)이
# 더 일정했다(23.4~23.7s). 즉 이 환경에서는 오버서브스크립션이 주된 원인이 아닌 걸로
# 보여서(실사용 중 봤던 편차는 그 세션에 떠 있던 다른 프로그램의 영향일 가능성이 더
# 큼 — 격리된 진단 스크립트로는 재현 안 됨) 기본값으로 되돌린다.
CPU_THREADS = None


def get_engine(language: str, model_name: str = RECOGNITION_MODEL_NAME) -> PaddleOCR:
    paddle_lang = LANG_MAP.get(language, "en")
    # 담당 A — 가로쓰기 후리가나 노이즈 대응 실험(2026-07-29). 인식 모델을 요청마다
    # 다르게 넘길 수 있게(가벼운 모델로 속도 실험, ocrPaddle.ts: recognizeWithPaddle
    # 의 recModel 인자) 캐시 키에 모델명을 포함한다 — 언어만으로 캐싱하던 이전 방식은
    # 모델이 바뀌어도 이전에 로드된(다른 모델의) 엔진을 그대로 재사용해버리는 버그가 됨.
    key = f"{paddle_lang}:{model_name}"
    if key not in _engines:
        # enable_mkldnn=False 필수 — 켜두면(기본값) 이 환경에서 oneDNN 실행기가
        # "ConvertPirAttribute2RuntimeAttribute not support" 로 매번 죽었다(실측 확인,
        # PaddlePaddle/oneDNN 조합 버그로 보임). 문서 방향 보정도 꺼서(스크린샷은 항상
        # 똑바로 서 있으므로 불필요) 조금이라도 더 빠르게 한다.
        _engines[key] = PaddleOCR(
            lang=paddle_lang,
            text_recognition_model_name=model_name,
            cpu_threads=CPU_THREADS,
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
        )
    return _engines[key]


def get_detector() -> TextDetection:
    global _detector
    if _detector is None:
        _detector = TextDetection(cpu_threads=CPU_THREADS, enable_mkldnn=False)
    return _detector


def detect_lines(image_path: str, _language: str) -> list[dict]:
    """줄 단위 박스만 필요할 때(세로쓰기 일본어 등 — ocr.ts/ocrManga.ts 참고) 쓴다.

    예전엔 `PaddleOCR.predict()`(검출+인식 풀 파이프라인)를 통째로 돌리고 인식된 텍스트
    (rec_texts)만 버리는 식이었는데, 실측 확인 결과 이러면 우리가 안 쓰는 인식 단계까지
    매번 돌게 돼서 소요 시간이 크롭 면적이 아니라 "검출된 줄 개수"에 비례해 늘어났다
    (넓은 영역이라 줄이 많이 나올수록 그만큼 느려짐 — 실측: 560×880 크롭에서 22~38초).
    `TextDetection`(검출 전용, 인식 없음)으로 바꾸니 같은 크롭이 7초 안팎으로 끝났다.
    `_language` 는 이제 안 쓴다(검출은 언어를 안 타서 — Node 쪽이 여전히 이 필드를
    요청에 실어 보내므로 시그니처만 유지하고 무시한다, 프로토콜 변경 없이 교체하려고).
    """
    detector = get_detector()
    results = detector.predict(image_path)
    lines = []
    for r in results:
        polys = r.get("dt_polys")
        if polys is None:
            continue
        for poly in polys:
            xs = [float(pt[0]) for pt in poly]
            ys = [float(pt[1]) for pt in poly]
            lines.append({"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)})
    return lines


# PaddleOCR 인식 결과에 아주 가끔 깨진(짝이 안 맞는, lone surrogate) 유니코드 문자가
# 섞여 나온다(실사용 중 확인 — 원인은 불명확하나 인식 모델/사전 내부 디코딩 문제로
# 보임). 이런 문자는 UTF-8로 인코딩이 안 돼서 그대로 두면 아래 serve() 의
# print(json.dumps(...)) 자체가 예외를 던지고, 그 예외를 잡아 에러 응답을 만들려는
# json.dumps({"error": ...}) 조차 같은 이유로 또 실패해 서버 프로세스가 죽어버린다
# (실사용 중 "텍스트 상자가 아예 안 뜸"으로 확인 — 그 워커가 죽어서 응답을 영영 못 줌).
# UTF-8로 왕복 인코딩/디코딩해서 이런 문자를 조용히 제거한다.
def _strip_lone_surrogates(text: str) -> str:
    return text.encode("utf-8", "ignore").decode("utf-8")


def recognize(image_path: str, language: str, model_name: str = RECOGNITION_MODEL_NAME) -> list[dict]:
    engine = get_engine(language, model_name)
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
                w = _strip_lone_surrogates(w)
                if not w:  # 깨진 문자만 있던 토큰이면 제거 후 빈 문자열 — 통째로 제외
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
                # rec_model 이 없으면(기존 호출부) 기본 모델 그대로 — 프로토콜 하위호환.
                model_name = req.get("rec_model", RECOGNITION_MODEL_NAME)
                words = recognize(req["image_path"], req["language"], model_name)
                print(json.dumps({"words": words}), flush=True)
        except Exception as e:
            # 에러 메시지 자체에 깨진 문자가 섞여 있으면 이 print 마저 실패해 서버 프로세스가
            # 죽는다(실사용 중 확인 — recognize() 안의 _strip_lone_surrogates 로 대부분
            # 막았지만, 예상 못 한 다른 경로까지 대비한 이중 안전장치).
            print(json.dumps({"error": _strip_lone_surrogates(str(e))}), flush=True)


if __name__ == "__main__":
    serve()
