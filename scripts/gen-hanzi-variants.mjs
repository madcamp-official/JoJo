// src/shared/hanziVariants.ts 를 재생성한다 — OpenCC(BYVoid/OpenCC, MIT)의 단일 문자
// 매핑 데이터(STCharacters/TSCharacters)에서 "간체/번체 어느 한쪽에만 나타나는 글자"만
// 추려 판별용 표본을 만든다. opencc-js 를 의존성으로 두지 않고, jsDelivr CDN에서 원본
// 데이터 파일만 그때그때 받아온다(런타임 번들에는 이 표본 문자열만 들어감).
//
//     node scripts/gen-hanzi-variants.mjs

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://cdn.jsdelivr.net/npm/opencc-js/dist/esm-lib/dict'

async function fetchDict(name) {
  const res = await fetch(`${BASE}/${name}.js`)
  if (!res.ok) throw new Error(`${name} 다운로드 실패: ${res.status}`)
  const src = await res.text()
  const match = src.match(/export default "([^]*)"/)
  if (!match) throw new Error(`${name} 파싱 실패 — 포맷이 바뀌었을 수 있음`)
  return match[1]
}

function extractOnlyChars(pairs, otherIncludesSelf) {
  const only = new Set()
  for (const pair of pairs.split('|')) {
    const [head, restRaw] = pair.split(' ')
    if (!head || !restRaw) continue
    const rest = restRaw.split(' ')
    if (!rest.includes(head)) only.add(head)
  }
  return only
}

const [st, ts] = await Promise.all([fetchDict('STCharacters'), fetchDict('TSCharacters')])

const simpOnly = extractOnlyChars(st) // 왼쪽=간체, 오른쪽=번체 후보들
const tradOnly = extractOnlyChars(ts) // 왼쪽=번체, 오른쪽=간체 후보들

// 양쪽에 다 나타나는 애매한 글자는 판별에 안 쓴다.
for (const c of simpOnly) if (tradOnly.has(c)) simpOnly.delete(c)
for (const c of tradOnly) if (simpOnly.has(c)) tradOnly.delete(c)

const content = `// 간체/번체 전용 한자 표본 — OpenCC(BYVoid/OpenCC, MIT) 의 STCharacters/TSCharacters
// 단일 문자 매핑 데이터에서 생성. \`scripts/gen-hanzi-variants.mjs\` 로 재생성 가능.
// "이 글자가 간체/번체 어느 한쪽에만 나타나는가"만 걸러 판별용 표본으로 쓴다(양쪽 다
// 나타나는 애매한 글자는 제외). 기존엔 각 17자/90자짜리 수작업 표본을 썼는데(예전
// cjkDetect.ts, langDetect.ts 가 서로 다른 표본을 따로 관리해 결과가 갈릴 수 있었음),
// 이걸로 두 판별 지점을 하나로 합친다.
export const SIMPLIFIED_ONLY_CHARS =
  '${[...simpOnly].join('')}'
export const TRADITIONAL_ONLY_CHARS =
  '${[...tradOnly].join('')}'
`

writeFileSync(resolve(root, 'src/shared/hanziVariants.ts'), content, 'utf8')
console.log(`생성 완료: 간체전용 ${simpOnly.size}자, 번체전용 ${tradOnly.size}자`)
