# 실험용: DocLayout-YOLO + PaddleOCR + manga-ocr (`experiment/doclayout-yolo` 브랜치)

Tesseract 단일 패스는 2단 이상 레이아웃에서 열을 뒤섞어 읽고, 일본어 스캔 파일
인식률도 낮았다(실사용 확인). 이 실험은 세 모델을 역할별로 나눠 붙인다:

- **DocLayout-YOLO**(`layout_detect.py`, opendatalab, HF `juliozhao/DocLayout-YOLO-DocStructBench`)
  — 본문 영역 자동 감지 + 다단/세로쓰기 읽기 순서 결정
- **PaddleOCR**(`ocr_paddle.py`) — en/zh/ja(가로쓰기) 텍스트 검출+인식, 글자 단위 실제 bbox 제공
- **manga-ocr**(`ocr_manga.py`, HF `kha-white/manga-ocr-base`) — 세로쓰기 일본어(망가 등) 인식
  전용(PaddleOCR 로 줄 위치만 잡고 텍스트는 manga-ocr 로 받음)

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

첫 실행 시 각 스크립트가 Hugging Face Hub/PaddleX 허브에서 모델 가중치를 자동
다운로드해 캐시한다(인터넷 필요, 이후 재실행은 캐시 사용). PaddleOCR 는 언어별로
det/rec 모델을 따로 받아서 첫 인식 때 조금 오래 걸릴 수 있다.

**Windows 실측 이슈**: PaddleOCR 를 `enable_mkldnn=True`(기본값)로 쓰면 이 환경에서
`NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support` 로 매번
죽었다(PaddlePaddle/oneDNN 조합 버그로 보임) — `ocr_paddle.py` 에서 이미
`enable_mkldnn=False` 로 고정해뒀다.

## 이 설정 없이 앱을 실행하면

각 Node 클라이언트(`layoutDetect.ts`/`ocrPaddle.ts`/`ocrManga.ts`)가 Python 실행
실패를 감지하면 `null`을 반환하고, `ocr.ts: runOcr()`는 자동으로 기존 Tesseract
경로로 폴백한다 — 즉 `python/.venv`가 없어도 앱은 정상 동작하고, 다단 레이아웃
재정렬 + PaddleOCR/manga-ocr 인식 기능만 빠진다(en/ja/zh 전부 Tesseract 로 처리).

## 동작 확인

```bash
# 레이아웃(1회성 CLI 모드 지원)
.venv/Scripts/python layout_detect.py <이미지경로> [--region x,y,w,h]

# PaddleOCR/manga-ocr 는 상주 서버 전용(표준입출력, 한 줄 = 요청/응답) — 수동
# 확인하려면 stdin 에 JSON 한 줄을 보내면 된다:
echo {"image_path": "<경로>", "language": "ja"} | .venv/Scripts/python ocr_paddle.py
echo {"image_path": "<경로>"} | .venv/Scripts/python ocr_manga.py
```

레이아웃 표준출력 마지막 줄에 `{"blocks": [...], "vertical": bool}` JSON을 찍는다
(각 블록에 읽기 순서 `order` 포함, 가로쓰기는 왼쪽→오른쪽, 세로쓰기로 판단되면
오른쪽→왼쪽 열 순서로 정렬됨).
