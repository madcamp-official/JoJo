# 실험용: DocLayout-YOLO 다단 레이아웃 검출 (`experiment/doclayout-yolo` 브랜치)

Tesseract 단일 패스는 2단 이상 레이아웃에서 열을 뒤섞어 읽는 경우가 있다. 이 실험은
DocLayout-YOLO(opendatalab, HF: `juliozhao/DocLayout-YOLO-DocStructBench`)로 레이아웃
블록을 먼저 찾고, 블록별로 Tesseract 를 순서대로 돌려 이어붙이는 방식을 시도한다.
자세한 배경은 `TODO.md` 참고.

## 설정

```bash
cd python
python -m venv .venv
# Windows
.venv\Scripts\pip install -r requirements.txt
# macOS/Linux
.venv/bin/pip install -r requirements.txt
```

첫 실행 시 `layout_detect.py`가 Hugging Face Hub에서 모델 가중치(~40MB)를 자동
다운로드해 캐시한다(인터넷 필요, 이후 재실행은 캐시 사용).

## 이 설정 없이 앱을 실행하면

`layoutDetect.ts: detectLayoutBlocks()`가 Python 실행 실패를 감지하면 `null`을
반환하고, `ocr.ts: runOcr()`는 자동으로 기존 Tesseract 단일 패스로 폴백한다 —
즉 `python/.venv`가 없어도 앱은 정상 동작하고, 다단 레이아웃 재정렬 기능만 빠진다.

## 동작 확인

```bash
.venv/Scripts/python layout_detect.py <이미지경로> [--region x,y,w,h]
```

표준출력 마지막 줄에 `{"blocks": [...]}`  JSON을 찍는다(각 블록에 읽기 순서 `order`
포함, 왼쪽 열 위→아래 → 오른쪽 열 위→아래 순으로 정렬됨).
