#!/usr/bin/env python3
"""jmdict-simplified(eng 변형) 원본 JSON을 resources/jmdict/ 번들 3개로 병합한다.

TODO.md/DICTIONARY_SOURCES.md 결정 사항: jisho.org 라이브 API가 아니라 jmdict-simplified
로컬 JSON 번들("full"+"eng" 변형)로 확정 — field(전문분야)/misc(사용역)/dialect(방언)가
각각 구조화된 배열로 오고, appliesToKanji/appliesToKana(이표기·읽기 제약)까지 있는데
jisho.org API는 이걸 tags 하나로 뭉개거나 아예 노출을 안 하기 때문("simplified"는
데이터 축소가 아니라 포맷 정리일 뿐이라 "full" 변형이 원본과 엔트리 수 동일 — README 확인).

사용법(재생성이 필요할 때만 — 이미 만들어진 resources/jmdict/*.json 은 저장소에 커밋돼
있어 평소엔 이 스크립트를 돌릴 필요가 없다):

    curl -L -o /tmp/jmdict-eng.json.tgz \\
      https://github.com/scriptin/jmdict-simplified/releases/download/<tag>/jmdict-eng-<tag>.json.tgz
    mkdir /tmp/jmdict && tar xzf /tmp/jmdict-eng.json.tgz -C /tmp/jmdict
    python3 scripts/build-jmdict-bundle.py /tmp/jmdict/jmdict-eng-*.json

원본 구조(실측 확인, jmdict-eng-3.6.2, 218,160 word 엔트리, 압축 해제 117MB):
  최상위: {version, languages, commonOnly, dictDate, dictRevisions, tags, words: [...]}
  word: {id, kanji: [{common, text, tags}], kana: [{common, text, tags, appliesToKanji}],
         sense: [{partOfSpeech, appliesToKanji, appliesToKana, related, antonym, field,
                   dialect, misc, info, languageSource, gloss: [{lang, gender, type, text}]}]}
  - kanji 가 없는 표제어(가나만, 예: らしい)도 있음 — headword 는 이 경우 kana.text 로 대체.
  - related/antonym 원소는 길이 1~3의 튜플([표제어] / [표제어, 읽기 or senseIndex] /
    [표제어, 읽기, senseIndex]) — 이 앱 스키마(seeAlso/antonyms 는 텍스트 하나만 필요)엔
    첫 원소(표제어 텍스트)만 있으면 충분해 튜플의 나머지는 버린다.
  - gloss 는 eng 변형만 받았으므로 이미 전부 lang: "eng" — 필터링 불필요, gender/type 은
    이 앱 스키마에 대응 필드가 없어 버린다.

이 앱이 쓰는 필드만 남기고(languageSource 등 미사용 필드는 버림) 3개 파일로 나눈다:
  - index.json: 표제어 표기(한자든 가나든) → word id 배열(정확 매치 조회용 역인덱스)
  - words.json: word id → 위 trimmed word 구조
  - tags.json: jmdict 최상위 tags(코드 → 영문 설명, 약 300개) 그대로 — misc/field/dialect
    코드를 사람이 읽을 수 있는 문자열로 바꿀 때 어댑터가 참조(usageTags/domain 매핑).
"""

import json
import os
import sys

USAGE = 'usage: build-jmdict-bundle.py <path-to-jmdict-eng-N.N.N.json>'


def trim_kana(kana: dict) -> dict:
    out = {'text': kana['text'], 'common': kana.get('common', False)}
    applies = kana.get('appliesToKanji') or []
    if applies and applies != ['*']:
        out['appliesToKanji'] = applies
    return out


def trim_kanji(kanji: dict) -> dict:
    return {'text': kanji['text'], 'common': kanji.get('common', False)}


def trim_sense(sense: dict) -> dict:
    out: dict = {'partOfSpeech': sense.get('partOfSpeech', [])}
    applies_kanji = sense.get('appliesToKanji') or []
    if applies_kanji and applies_kanji != ['*']:
        out['appliesToKanji'] = applies_kanji
    applies_kana = sense.get('appliesToKana') or []
    if applies_kana and applies_kana != ['*']:
        out['appliesToKana'] = applies_kana
    related = [r[0] for r in sense.get('related', []) if r]
    if related:
        out['related'] = related
    antonym = [a[0] for a in sense.get('antonym', []) if a]
    if antonym:
        out['antonym'] = antonym
    if sense.get('field'):
        out['field'] = sense['field']
    if sense.get('dialect'):
        out['dialect'] = sense['dialect']
    if sense.get('misc'):
        out['misc'] = sense['misc']
    if sense.get('info'):
        out['info'] = sense['info']
    out['gloss'] = [g['text'] for g in sense.get('gloss', [])]
    return out


def main() -> None:
    if len(sys.argv) != 2:
        print(USAGE, file=sys.stderr)
        sys.exit(1)
    src = sys.argv[1]
    if not os.path.isfile(src):
        print(f'not a file: {src}', file=sys.stderr)
        sys.exit(1)

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo_root, 'resources', 'jmdict')
    os.makedirs(out_dir, exist_ok=True)

    data = json.load(open(src, encoding='utf-8'))

    words: dict = {}
    index: dict = {}
    for w in data['words']:
        wid = w['id']
        kanji = [trim_kanji(k) for k in w.get('kanji', [])]
        kana = [trim_kana(k) for k in w.get('kana', [])]
        sense = [trim_sense(s) for s in w.get('sense', [])]
        words[wid] = {'kanji': kanji, 'kana': kana, 'sense': sense}

        for surface in [k['text'] for k in kanji] + [k['text'] for k in kana]:
            bucket = index.get(surface)
            if bucket is None:
                index[surface] = [wid]
            elif wid not in bucket:
                bucket.append(wid)

    with open(os.path.join(out_dir, 'words.json'), 'w', encoding='utf-8') as f:
        json.dump(words, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out_dir, 'tags.json'), 'w', encoding='utf-8') as f:
        json.dump(data['tags'], f, ensure_ascii=False, separators=(',', ':'))

    print(f'words: {len(words)}, index entries: {len(index)}, tags: {len(data["tags"])}')
    for name in ('words.json', 'index.json', 'tags.json'):
        p = os.path.join(out_dir, name)
        print(f'{name}: {os.path.getsize(p) / 1024 / 1024:.1f} MB')


if __name__ == '__main__':
    main()
