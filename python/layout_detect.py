"""담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.

DocLayout-YOLO(opendatalab, HF: juliozhao/DocLayout-YOLO-DocStructBench)로 캡처
이미지의 레이아웃 블록(텍스트/제목/표/그림 등)을 검출하고, 다단(2단 등) 배치를
가로쓰기면 "왼쪽 열 위→아래, 그다음 오른쪽 열 위→아래", 세로쓰기(일본어 세로쓰기·
망가 등)로 판단되면 반대로 "오른쪽 열 위→아래, 그다음 왼쪽 열" 순서로 정렬해 반환한다.

Node(layoutDetect.ts)가 이 스크립트를 두 가지 방식으로 호출한다:
  1) 1회성: python layout_detect.py <image_path> [--region x,y,w,h]
     표준출력에 JSON 한 줄:
     { blocks: [{x,y,width,height,label,confidence,order,column}, ...], vertical: bool }
  2) 서버 모드(실제로 앱이 쓰는 방식): python layout_detect.py --serve
     표준입력에서 한 줄씩 요청을 읽는다: {"image_path": "...", "region": [x,y,w,h] | null}
     처리할 때마다 표준출력에 응답 한 줄: {"blocks": [...], "vertical": bool} 또는 {"error": "..."}
     — Python/torch 시작 비용(수 초)과 모델 로딩을 딱 한 번만 치르고 프로세스를 계속
     살려둔 채 재사용하기 위함이다. 1회성 호출은 매번 이 비용을 전부 다시 내야 해서
     실사용 중 "창 리사이즈 후 재추출까지 너무 오래 걸림"(실측: 추론 자체는 1초인데
     전체는 8초+, 대부분 torch import + 모델 로딩)으로 확인돼 서버 모드로 바꿨다.

읽기 순서 정렬은 모델이 주는 것을 쓰지 않고(DocStructBench 체크포인트는 클래스만
주고 순서는 안 줌, 텍스트 방향도 전혀 모름) 아래 규칙으로 직접 계산한다:
  1) 블록들을 x 중심 좌표로 군집화해 "열"을 나눈다(간단한 1차원 클러스터링 —
     열 사이 간격이 블록 폭보다 뚜렷이 크다는 가정). 각 블록에 몇 번째 열인지
     `column` 인덱스를 매긴다(가로쓰기는 왼쪽부터 0,1,2..., 세로쓰기는 아래 참고).
  2) 열 안에서는 항상 위→아래 순서. 열 자체의 순서는 가로쓰기면 왼쪽→오른쪽,
     세로쓰기(일본어 세로쓰기·망가 등)로 판단되면 오른쪽→왼쪽으로 뒤집는다
     (`is_vertical_layout` — 본문/제목 블록 대부분이 폭보다 높이가 뚜렷이 큰
     좁고 긴 모양이면 세로쓰기로 본다. 세로쓰기 문단은 한 줄이 곧 한 "열"이 되는
     구조라 가로쓰기와 같은 x좌표 군집화 로직을 그대로 재사용할 수 있고, 열의
     좌→우/우→좌 순서만 뒤집으면 된다).
이 규칙은 신문/논문처럼 열이 세로로 쭉 이어지는 레이아웃엔 잘 맞고, 열 경계가
y 축마다 달라지는 복잡한 잡지 레이아웃 등은 후순위 문제로 남겨둔다.

`column` 을 따로 주는 이유: 같은 열 안에서도 모델이 문단을 여러 블록으로 쪼개
검출하는 경우가 있는데, Node(ocr.ts) 가 블록마다 따로 Tesseract 를 돌리면 그
블록 경계가 실제 문장 중간을 가로질러 글자가 잘리는 문제가 있었다(실사용 중
"영역 중간에도 클릭 안 되는 단어 + 팝업에서 첫 글자 잘림"으로 확인). 그래서
Node 쪽에서 `column` 이 같은 블록들을 하나의 큰 사각형으로 합쳐서(열 전체를
한 번에) Tesseract 를 돌리도록 바꿨다 — 블록 단위가 아니라 열 단위로만 잘라서
열과 열 "사이"의 진짜 여백에서만 경계가 생기게 한다.
"""

import argparse
import json
import sys

from doclayout_yolo import YOLOv10
from huggingface_hub import hf_hub_download

MODEL_REPO = "juliozhao/DocLayout-YOLO-DocStructBench"
MODEL_FILE = "doclayout_yolo_docstructbench_imgsz1024.pt"

_model = None


def get_model():
    global _model
    if _model is None:
        weights_path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
        _model = YOLOv10(weights_path)
    return _model


def cluster_columns(blocks, gap_ratio=0.6):
    """블록의 x0 를 기준으로 정렬한 뒤, 이전 블록의 x1 과 다음 블록의 x0 사이 간격이
    두 블록 폭의 평균의 gap_ratio 배보다 크면 새 열로 나눈다."""
    if not blocks:
        return []
    ordered = sorted(blocks, key=lambda b: b["x"])
    columns = [[ordered[0]]]
    for prev, cur in zip(ordered, ordered[1:]):
        avg_width = (prev["width"] + cur["width"]) / 2
        gap = cur["x"] - (prev["x"] + prev["width"])
        if gap > avg_width * gap_ratio:
            columns.append([cur])
        else:
            columns[-1].append(cur)
    return columns


def is_vertical_layout(blocks, ratio_threshold=1.4, min_fraction=0.5):
    """본문/제목 블록 대부분이 폭보다 높이가 `ratio_threshold` 배 이상 크면(좁고
    길쭉하면) 세로쓰기 페이지로 본다. 그림/표 같은 비텍스트 블록은 텍스트 방향과
    무관해서 판정에서 제외한다. 표본이 아예 없으면(본문 블록 미검출) 판단 근거가
    없으므로 False(가로쓰기 취급 — 기존 동작 유지)."""
    text_blocks = [b for b in blocks if b["label"] in ("plain text", "title") and b["width"] > 0]
    if not text_blocks:
        return False
    vertical_count = sum(1 for b in text_blocks if b["height"] / b["width"] >= ratio_threshold)
    return (vertical_count / len(text_blocks)) >= min_fraction


def order_blocks(blocks):
    vertical = is_vertical_layout(blocks)
    columns = cluster_columns(blocks)
    # 가로쓰기: 왼쪽 → 오른쪽. 세로쓰기(일본어 세로쓰기·망가 등): 오른쪽 → 왼쪽
    # (전통적인 세로쓰기 읽기 순서 — 첫 줄이 페이지 오른쪽 끝에 옴).
    columns.sort(key=lambda col: min(b["x"] for b in col), reverse=vertical)
    ordered = []
    for col_index, col in enumerate(columns):
        col.sort(key=lambda b: b["y"])
        for b in col:
            b["column"] = col_index
        ordered.extend(col)
    for i, b in enumerate(ordered):
        b["order"] = i
    return ordered, vertical


def detect(image_path: str, region: tuple[int, int, int, int] | None):
    model = get_model()
    # verbose=False: 기본값으로 두면 predict() 가 "image 1/1 ... Speed: ..." 같은 로그를
    # stdout 에 찍는데, 서버 모드에서는 stdout 한 줄 = 응답 한 줄이어야 하므로 이 노이즈가
    # 섞이면 프로토콜이 깨진다.
    results = model.predict(image_path, imgsz=1024, conf=0.25, device="cpu", verbose=False)
    blocks = []
    for result in results:
        names = result.names
        for box in result.boxes:
            x0, y0, x1, y1 = [float(v) for v in box.xyxy[0].tolist()]
            if region:
                rx, ry, rw, rh = region
                # 지정 영역과 안 겹치는 블록은 버린다(선택 영역 밖 레이아웃 무시).
                if x1 < rx or y1 < ry or x0 > rx + rw or y0 > ry + rh:
                    continue
            label = names[int(box.cls[0])]
            blocks.append({
                "x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0,
                "label": label, "confidence": float(box.conf[0]),
            })
    return order_blocks(blocks)  # (ordered_blocks, vertical)


def serve():
    """표준입력에서 요청을 한 줄씩 읽어 처리하는 상주 모드 — 모델은 첫 요청 때 한 번만
    로드하고 계속 재사용한다. 한 줄이 요청 하나, 한 줄이 응답 하나(순서 보장, Node
    쪽도 요청을 한 번에 하나씩만 보낸다 — layoutDetect.ts 의 큐 참고)."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            region = tuple(req["region"]) if req.get("region") else None
            blocks, vertical = detect(req["image_path"], region)
            print(json.dumps({"blocks": blocks, "vertical": vertical}), flush=True)
        except Exception as e:  # 요청 하나가 실패해도 서버 프로세스 자체는 계속 살아있어야 함
            print(json.dumps({"error": str(e)}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image_path", nargs="?")
    parser.add_argument("--region", type=str, default=None, help="x,y,w,h")
    parser.add_argument("--serve", action="store_true", help="상주 서버 모드(표준입출력)")
    args = parser.parse_args()

    if args.serve:
        serve()
        return

    region = None
    if args.region:
        region = tuple(float(v) for v in args.region.split(","))

    blocks, vertical = detect(args.image_path, region)
    print(json.dumps({"blocks": blocks, "vertical": vertical}))


if __name__ == "__main__":
    main()
