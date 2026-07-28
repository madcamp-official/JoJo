// chinese-tokenizer 는 자체 타입 선언이 없고 @types/chinese-tokenizer 도 없어 필요한
// 만큼만(loadFile, 토큰의 text 필드) 최소 선언한다.
declare module 'chinese-tokenizer' {
  export interface ChineseToken {
    text: string
    traditional: string
    simplified: string
    position: { offset: number; line: number; column: number }
    matches: { pinyin: string; pinyinPretty: string; english: string }[]
  }

  export function loadFile(path: string): (text: string) => ChineseToken[]
  export function load(content: string): (text: string) => ChineseToken[]
}
