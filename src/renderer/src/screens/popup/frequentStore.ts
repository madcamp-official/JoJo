// 담당 B — 자주 쓰는 질문 (렌더러 측 얇은 래퍼)
//
// 저장은 main 프로세스가 userData/frequent.json 에 담당한다(설정·API 키와 동일 경로).
// 앱 재시작·재설치 후에도 유지된다. (localStorage 임시 저장에서 이전됨.)

export function loadFrequent(): Promise<string[]> {
  return window.nuance.getFrequent()
}

export function saveFrequent(list: string[]): void {
  void window.nuance.setFrequent(list)
}
