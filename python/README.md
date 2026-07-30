# Python 엔진 (레이아웃 / OCR / 형태소)

Tesseract 단일 패스는 2단 이상 레이아웃에서 열을 뒤섞어 읽고, 일본어 스캔 파일
인식률도 낮았다(실사용 확인). 그래서 모델을 역할별로 나눠 붙였다 — 각 스크립트는
Node 쪽(`src/main/selection/*.ts`)이 표준입출력으로 말을 거는 상주 서버다
(`pythonServer.ts` 공용 브릿지):

- **DocLayout-YOLO**(`layout_detect.py`, opendatalab, HF `juliozhao/DocLayout-YOLO-DocStructBench`)
  — 본문 영역 자동 감지 + 다단/세로쓰기 읽기 순서 결정
- **PaddleOCR**(`ocr_paddle.py`) — en/zh/ja 텍스트 검출+인식, 글자 단위 실제 bbox 제공.
  일본어에서는 아래 두 엔진이 실패했을 때의 폴백이기도 하다
- **Yomitoku**(`ocr_yomitoku.py`) — 일본어 **가로쓰기 줄 검출 전용**. PaddleOCR 검출이
  후리가나를 본문과 한 박스로 합쳐버리는 페이지를 피하려고 검출만 이걸로 바꿔 씀
- **NDLOCR-Lite**(`ocr_ndlocr.py`) — 일본어 특화(국립국회도서관 고문서 모델) 검출+인식.
  세로쓰기는 검출+인식 전부, 가로쓰기는 Yomitoku 가 찾은 줄의 인식을 담당.
  **의존성 충돌 때문에 별도 venv 필요** — 아래 전용 섹션 참고
- **SudachiPy**(`sudachi_tokenize.py`) — 일본어 형태소 분석(UniDic), OCR 결과 단어 재분할용

자세한 배경은 `TODO.md` 참고.

## 설정

**Python 3.12 필수** — paddlepaddle 이 아직 3.14 를 지원하지 않는다(실측 확인:
`pip install paddlepaddle` 가 3.14 venv 에서 "Could not find a version that
satisfies the requirement" 로 실패함). doclayout_yolo/torch 는 3.12 에서도 정상
동작해서 venv 하나로 통일했다.

```bash
cd python
py -3.12 -m venv .venv   # Windows, 3.12 가 여러 개 설치돼있으면 경로 지정 필요
# Windows
.venv\Scripts\pip install -r requirements.txt
# macOS/Linux
.venv/bin/pip install -r requirements.txt
```

## NDLOCR-Lite(일본어 특화 인식) — 별도 venv 필수

일본어 경로(`ocr_ndlocr.py`)가 쓰는 NDLOCR-Lite 는 **공용 venv 에 설치하면 안 된다** —
numpy/opencv/onnxruntime 을 낮은 버전으로 못박아 끌어내려서 PaddleOCR/Yomitoku 가
요구하는 버전과 충돌한다(실제로 한 번 공용 환경이 깨진 적 있음). 그래서 `.venv` 와
완전히 분리된 `.venv-ndlocr-test` 에 `requirements-ndlocr.txt` 만 설치한다:

```bash
cd python
python3 -m venv .venv-ndlocr-test          # Windows: py -3.12 -m venv .venv-ndlocr-test
# Windows
.venv-ndlocr-test\Scripts\pip install -r requirements-ndlocr.txt
# macOS/Linux
.venv-ndlocr-test/bin/pip install -r requirements-ndlocr.txt
```

모델 가중치(deim/parseq, 약 160MB)는 저장소에 동봉돼 있어 설치 시 함께 들어온다 —
별도 다운로드 단계가 없다. `pythonServer.ts: NDLOCR_PYTHON_BIN` 이 이 venv 의
인터프리터를 직접 스폰하고, `ocr_ndlocr.py` 는 자기 인터프리터의 site-packages 를
`sysconfig` 로 찾아 sys.path 에 넣으므로 플랫폼별 경로 차이는 신경 쓸 필요 없다.

이 venv 가 없으면 `ocrNdlocr.ts` 가 조용히 `null` 을 반환해 PaddleOCR 경로로
폴백한다 — 앱은 정상 동작하고 일본어 인식 품질만 떨어진다(검출은 Yomitoku 가
계속 담당).

첫 실행 시 각 스크립트가 Hugging Face Hub/PaddleX 허브에서 모델 가중치를 자동
다운로드해 캐시한다(인터넷 필요, 이후 재실행은 캐시 사용). PaddleOCR 는 언어별로
det/rec 모델을 따로 받아서 첫 인식 때 조금 오래 걸릴 수 있다.

**Windows 실측 이슈**: PaddleOCR 를 `enable_mkldnn=True`(기본값)로 쓰면 이 환경에서
`NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support` 로 매번
죽었다(PaddlePaddle/oneDNN 조합 버그로 보임) — `ocr_paddle.py` 에서 이미
`enable_mkldnn=False` 로 고정해뒀다.

## 이 설정 없이 앱을 실행하면

각 Node 클라이언트(`layoutDetect.ts`/`ocrPaddle.ts`/`ocrYomitoku.ts`/`ocrNdlocr.ts`)가
Python 실행 실패를 감지하면 `null`을 반환하고, 그때마다 한 단계씩 아래로 폴백한다 —
**어느 venv 가 없든 앱 자체는 항상 정상 동작하고, 인식 품질만 조용히 떨어진다**(에러가
겉으로 안 드러나므로, 특정 언어 품질이 이상하면 venv 부터 의심할 것):

- `python/.venv` 없음 → 다단 레이아웃 재정렬 + PaddleOCR 인식이 통째로 빠지고
  `ocr.ts: runOcr()`가 en/ja/zh 전부 기존 Tesseract 경로로 처리
- `python/.venv-ndlocr-test` 없음 → 일본어 특화 인식(NDLOCR-Lite)만 빠지고 PaddleOCR
  인식으로 폴백. 검출은 Yomitoku 가 그대로 담당하므로 후리가나 처리는 유지됨
  (실제로 macOS 개발 환경이 2026-07-31 까지 계속 이 상태였다 — TODO.md 참고)

## 동작 확인

```bash
# 레이아웃(1회성 CLI 모드 지원)
.venv/Scripts/python layout_detect.py <이미지경로> [--region x,y,w,h]

# PaddleOCR 는 상주 서버 전용(표준입출력, 한 줄 = 요청/응답) — 수동
# 확인하려면 stdin 에 JSON 한 줄을 보내면 된다:
echo {"image_path": "<경로>", "language": "ja"} | .venv/Scripts/python ocr_paddle.py

# NDLOCR-Lite 도 같은 상주 서버 패턴 — 단, 인터프리터는 격리 venv 쪽을 써야 한다.
# 세로쓰기(검출+인식): {"lines": [{text, x0, y0, x1, y1, direction, rec_score}, ...]}
echo '{"image_path": "<경로>"}' | .venv-ndlocr-test/bin/python ocr_ndlocr.py
# 가로쓰기 단일 줄 크롭 인식(Yomitoku 검출 결과를 읽는 경로): {"text": "..."}
echo '{"mode": "recognize_crop", "image_path": "<줄크롭경로>"}' | .venv-ndlocr-test/bin/python ocr_ndlocr.py
```

레이아웃 표준출력 마지막 줄에 `{"blocks": [...], "vertical": bool}` JSON을 찍는다
(각 블록에 읽기 순서 `order` 포함, 가로쓰기는 왼쪽→오른쪽, 세로쓰기로 판단되면
오른쪽→왼쪽 열 순서로 정렬됨).
