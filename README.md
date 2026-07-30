# JoJo
몰입캠프 26s-w4-c3-07 프로젝트 repository

## 사전 데이터 준비

ja/zh 사전 어댑터(JMdict/OEWN/CC-CEDICT)가 쓰는 로컬 번들(`resources/`, 총 94MB)은
재생성 가능한 데이터라 저장소에 커밋하지 않는다(`.gitignore` 처리). **`npm run dev`/
`npm run build`(그리고 이를 거치는 `pack:dir`/`dist:*`) 실행 시 `resources/`가 없으면
`scripts/ensure-resources.sh`가 자동으로 다운로드·빌드하므로 보통은 따로 손댈 일이 없다.**

수동으로 개별 소스만 다시 받고 싶을 때는 아래 스크립트를 직접 실행(원본 다운로드 경로·버전
고정 근거는 [DICTIONARY_SOURCES.md](DICTIONARY_SOURCES.md) 참고):

```bash
bash scripts/fetch-oewn.sh      # OEWN (Open English WordNet)
bash scripts/fetch-jmdict.sh    # JMdict
bash scripts/fetch-cedict.sh    # CC-CEDICT
```

## 폰트

한중일영 통일 폰트(Noto Sans KR/JP/SC/TC, `src/renderer/src/assets/fonts/`, 총 ~50MB)도
같은 이유로 커밋하지 않는다 — `ensure-resources.sh`가 자동으로 받아오며, 수동으로 다시
받고 싶을 때는 `bash scripts/fetch-fonts.sh`.
