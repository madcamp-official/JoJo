# JoJo
몰입캠프 26s-w4-c3-07 프로젝트 repository

## 사전 데이터 준비

ja/zh 사전 어댑터(JMdict/OEWN/CC-CEDICT)가 쓰는 로컬 번들(`resources/`, 총 94MB)은
재생성 가능한 데이터라 저장소에 커밋하지 않는다(`.gitignore` 처리). clone 직후 아래 3개를
실행해야 사전 기능이 동작한다(원본 다운로드 경로·버전 고정 근거는
[DICTIONARY_SOURCES.md](DICTIONARY_SOURCES.md) 참고):

```bash
# OEWN (Open English WordNet)
curl -L -o /tmp/oewn.zip https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip
mkdir /tmp/oewn && unzip -q /tmp/oewn.zip -d /tmp/oewn
python3 scripts/build-oewn-bundle.py /tmp/oewn

# JMdict — <tag>는 jmdict-simplified 최신 릴리스 태그로 교체
curl -L -o /tmp/jmdict-eng.json.tgz https://github.com/scriptin/jmdict-simplified/releases/download/<tag>/jmdict-eng-<tag>.json.tgz
mkdir /tmp/jmdict && tar xzf /tmp/jmdict-eng.json.tgz -C /tmp/jmdict
python3 scripts/build-jmdict-bundle.py /tmp/jmdict/jmdict-eng-*.json

# CC-CEDICT
bash scripts/fetch-cedict.sh
```
