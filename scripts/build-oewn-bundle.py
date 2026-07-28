#!/usr/bin/env python3
"""OEWN(Open English WordNet) 원본 JSON 릴리스를 resources/oewn/ 번들 2개로 병합한다.

사용법 — resources/oewn/*.json 은 재생성 가능한 데이터라 저장소에 커밋하지 않는다
(.gitignore 처리, 2026-07-28). 새로 clone 했거나 갱신이 필요할 때 아래를 실행:

    curl -L -o /tmp/oewn.zip \\
      https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip
    mkdir /tmp/oewn && unzip -q /tmp/oewn.zip -d /tmp/oewn
    python3 scripts/build-oewn-bundle.py /tmp/oewn

원본 zip 구성(실측 확인, 2025-edition, 9.98MB):
  - entries-{0,a..z}.json: 표제어(lemma) → 품사 코드('n'/'v'/'a'/'s'/'r', 동형이의어는
    'n-1'/'n-2'처럼 번호 접미사) → { pronunciation[]?, form[]?(활용형), sense[](각 원소가
    id/synset/derivation/agent/also/event/sent/subcat 등 26종 필드를 가짐) }
  - {noun,verb,adj,adv}.<분류>.json (40여 개, 예: noun.animal.json/verb.motion.json):
    synset id → { definition[], example[]?, partOfSpeech, hypernym[]?, similar[]?, ... }
  - frames.json: 통사 프레임 정의(이 앱 스키마에서 안 씀)

이 앱(DictionaryEntry 스키마, DICTIONARY_SOURCES.md#oewn 참고)이 실제로 쓰는 필드는
entries 쪽 pronunciation/form/sense[].synset, synsets 쪽 definition/example/partOfSpeech
뿐이라, 그 외(derivation/agent/hypernym 등 synset 간 관계 정보)는 병합 단계에서 버려
원본 70MB(비압축 전체) 대비 resources/oewn/ 결과물을 22MB 대로 줄인다.
"""

import glob
import json
import os
import sys

USAGE = 'usage: build-oewn-bundle.py <path-to-unzipped-oewn-release-dir>'


def main() -> None:
    if len(sys.argv) != 2:
        print(USAGE, file=sys.stderr)
        sys.exit(1)
    src = sys.argv[1]
    if not os.path.isdir(src):
        print(f'not a directory: {src}', file=sys.stderr)
        sys.exit(1)

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo_root, 'resources', 'oewn')
    os.makedirs(out_dir, exist_ok=True)

    # ---- entries: lemma -> posKey -> { synsets: [id...], pronunciation?, form? } ----
    entries: dict = {}
    for path in sorted(glob.glob(os.path.join(src, 'entries-*.json'))):
        data = json.load(open(path, encoding='utf-8'))
        for lemma, by_pos in data.items():
            out_pos = {}
            for pos, info in by_pos.items():
                synsets = [s['synset'] for s in info.get('sense', []) if 'synset' in s]
                if not synsets:
                    continue
                entry = {'synsets': synsets}
                if info.get('pronunciation'):
                    entry['pronunciation'] = info['pronunciation']
                if info.get('form'):
                    entry['form'] = info['form']
                out_pos[pos] = entry
            if out_pos:
                entries[lemma] = out_pos

    with open(os.path.join(out_dir, 'entries.json'), 'w', encoding='utf-8') as f:
        json.dump(entries, f, ensure_ascii=False, separators=(',', ':'))

    # ---- synsets: id -> { definition[], example[]?, partOfSpeech } ----
    synsets: dict = {}
    lexfiles = [
        p
        for p in glob.glob(os.path.join(src, '*.json'))
        if os.path.basename(p) != 'frames.json' and not os.path.basename(p).startswith('entries-')
    ]
    for path in sorted(lexfiles):
        data = json.load(open(path, encoding='utf-8'))
        for sid, info in data.items():
            out = {
                'definition': info.get('definition', []),
                'partOfSpeech': info.get('partOfSpeech'),
            }
            if info.get('example'):
                out['example'] = info['example']
            synsets[sid] = out

    with open(os.path.join(out_dir, 'synsets.json'), 'w', encoding='utf-8') as f:
        json.dump(synsets, f, ensure_ascii=False, separators=(',', ':'))

    print(f'entries: {len(entries)}, synsets: {len(synsets)}')
    for name in ('entries.json', 'synsets.json'):
        p = os.path.join(out_dir, name)
        print(f'{name}: {os.path.getsize(p) / 1024 / 1024:.1f} MB')


if __name__ == '__main__':
    main()
