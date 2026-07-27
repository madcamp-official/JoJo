// segmentit 는 자체 타입 선언이 없고 @types/segmentit 도 없어 필요한 만큼만 최소 선언한다.
declare module 'segmentit' {
  export interface SegmentToken {
    w: string
    p?: number
  }

  export class Segment {
    use(modules: unknown): Segment
    loadDict(dicts: string | string[]): Segment
    loadSynonymDict(synonyms: unknown): Segment
    loadStopwordDict(stopwords: unknown): Segment
    doSegment(text: string, options?: Record<string, unknown>): SegmentToken[]
  }

  export function useDefault(segment: Segment): Segment
}
