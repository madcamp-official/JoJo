"""담당 A — 실험용 브랜치(experiment/doclayout-yolo) 전용.

DocLayout-YOLO(opendatalab, HF: juliozhao/DocLayout-YOLO-DocStructBench)로 캡처
이미지의 레이아웃 블록(텍스트/제목/표/그림 등)을 검출하고, 다단(2단 등) 배치를
"왼쪽 열 위→아래, 그다음 오른쪽 열 위→아래" 순서로 정렬해 반환한다.

Node(layoutDetect.ts)가 이 스크립트를 서브프로세스로 호출한다:
  python layout_detect.py <image_path> [--region x,y,w,h]
표준출력으로 JSON 한 줄을 찍는다: { blocks: [{x,y,width,height,label,confidence,order,column}, ...] }

읽기 순서 정렬은 모델이 주는 것을 쓰지 않고(DocStructBench 체크포인트는 클래스만
주고 순서는 안 줌) 아래 규칙으로 직접 계산한다:
  1) 블록들을 x 중심 좌표로 군집화해 "열"을 나눈다(간단한 1차원 클러스터링 —
     열 사이 간격이 블록 폭보다 뚜렷이 크다는 가정). 각 블록에 몇 번째 열인지
     `column` 인덱스(왼쪽부터 0, 1, 2...)를 매긴다.
  2) 열은 왼쪽→오른쪽 순서로, 열 안에서는 위→아래 순서로 정렬한다.
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


def order_blocks(blocks):
    columns = cluster_columns(blocks)
    # 열 자체도 왼쪽 → 오른쪽 순서로 정렬(cluster_columns 는 x0 정렬된 블록을 순서대로
    # 묶어서 생성 순서가 이미 왼쪽→오른쪽이지만, 명시적으로 한 번 더 보장한다).
    columns.sort(key=lambda col: min(b["x"] for b in col))
    ordered = []
    for col_index, col in enumerate(columns):
        col.sort(key=lambda b: b["y"])
        for b in col:
            b["column"] = col_index
        ordered.extend(col)
    for i, b in enumerate(ordered):
        b["order"] = i
    return ordered


def detect(image_path: str, region: tuple[int, int, int, int] | None):
    model = get_model()
    results = model.predict(image_path, imgsz=1024, conf=0.25, device="cpu")
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
    return order_blocks(blocks)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image_path")
    parser.add_argument("--region", type=str, default=None, help="x,y,w,h")
    args = parser.parse_args()

    region = None
    if args.region:
        region = tuple(float(v) for v in args.region.split(","))

    blocks = detect(args.image_path, region)
    print(json.dumps({"blocks": blocks}))


if __name__ == "__main__":
    main()
