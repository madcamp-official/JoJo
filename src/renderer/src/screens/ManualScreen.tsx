import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { exitToMainOrClose, goto } from '../navigate'
import { SHORTCUT_FIELDS, formatAccelerator } from '../shortcutMatch'

// 사용 설명서 화면 — 담당 A(2026-07-31, 사용자 요청). 설정 화면(SettingsScreen.tsx)과
// 같은 방식으로 메인 창을 재사용해 별도 화면처럼 전환된다(navigate.ts: goto('manual')).
// 레이아웃/CSS 클래스는 설정 화면 것을 그대로 재사용한다(styles.css: .settings-screen/
// .settings-header/.settings-section/.desc) — 이 화면만의 독자적인 스타일은 최소화하고
// "설정 화면처럼 보이는 또 다른 화면"으로 남긴다.
//
// 내용은 두 출처를 합친 것이다: (1) 이 프로젝트의 현재 기능 전체(창 선택 → 선택 모드 →
// 팝업 → 뷰어 → 트레이 메뉴 → 설정 각 섹션)를 다시 설명한 워크플로 가이드, (2) 설정 화면
// UI를 다듬으며(2026-07-30~31) 화면 밖으로 뺐던 설명 문구(docs/manual-draft.md 에 임시로
// 모아뒀던 것) — 단축키 제약, 자동 탐지 동작 시점, 언어 등급 안내 등을 그대로 옮겨왔다.
// 단축키 섹션만은 고정 문구가 아니라 지금 저장된 실제 값을 그대로 보여준다(사용자 요청,
// 2026-07-31 — 사용자가 단축키를 바꿔놓으면 설명서도 그 값을 따라가야 어긋나지 않는다).
export function ManualScreen() {
  const [hasSelection, setHasSelection] = useState(false)
  useEffect(() => {
    window.nuance.getSelectedWindowId().then((id) => setHasSelection(id !== null))
  }, [])

  const [settings, setSettings] = useState<AppSettings | null>(null)
  useEffect(() => {
    window.nuance.getSettings().then(setSettings)
  }, [])

  // Esc → 나가기 — 설정 화면과 동일한 규칙(exitToMainOrClose, navigate.ts 주석 참고).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') exitToMainOrClose(hasSelection)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hasSelection])

  return (
    <div className="screen settings-screen manual-screen">
      <div className="settings-header">
        <button className="icon-btn back" onClick={() => exitToMainOrClose(hasSelection)}>
          ←
        </button>
        <h1>사용 설명서</h1>
      </div>

      <p className="manual-intro">
        Nuance는 화면 위에서 바로 외국어 텍스트를 짚어 뜻·발음·문맥을 물어볼 수 있는 앱입니다.
        영상 자막, 웹페이지, PDF/문서 등 어디서 보고 있는 텍스트든 창 하나를 고르는 것만으로
        시작할 수 있습니다.
      </p>

      <section className="settings-section">
        <h2>1. 시작하기 — 창 선택</h2>
        <p className="desc">
          메인 화면의 "창 선택" 버튼을 누르면 지금 열려있는 창 목록이 뜹니다. 텍스트를 찾고
          싶은 창(브라우저·PDF 뷰어·메모장 등)을 고르면 그 창이 대상으로 선택되고, Nuance는
          백그라운드로 물러나 트레이 아이콘으로만 남습니다 — 대상 창을 그대로 계속 사용하면
          됩니다. 다른 창으로 바꾸거나 선택을 해제하려면 트레이 아이콘을 클릭해 메뉴에서
          고르면 됩니다(아래 "6. 트레이 메뉴" 참고).
        </p>
      </section>

      <section className="settings-section">
        <h2>2. 선택 모드로 텍스트 찾기</h2>
        <p className="desc">
          모드 전환 단축키를 누르면 선택 모드로 들어갑니다 — 대상 창 테두리 색이 파랑(일반
          모드)에서 보라(선택 모드)로 바뀝니다. 선택 모드에서 대상 창 위로 마우스를 올리면
          텍스트가 있는 자리에서 커서 모양이 바뀌고 밑에 있는 줄/단어가 하이라이트됩니다 —
          그 상태에서 클릭하면 근방 텍스트를 담은 팝업이 뜹니다.
        </p>
        <p className="desc">
          텍스트를 인식할 영역은 두 가지 방식 중 하나로 정해집니다: 설정의 "텍스트 영역 자동
          탐지"가 켜져 있으면 선택 모드로 들어가거나 창 크기가 바뀔 때마다 자동으로 본문
          영역을 다시 찾고, 꺼져 있으면 직접 드래그해서 영역을 지정합니다. 자동 탐지 결과가
          마음에 안 들면 트레이 메뉴의 "영역 수동 선택"으로 언제든 드래그 지정으로 덮어쓸 수
          있습니다.
        </p>
        <p className="desc">
          영역을 직접 드래그로 지정하면(수동 선택), 선택 모드를 유지하는 내내 그 영역 밖이
          반투명 회색으로 덮여 지금 어디까지가 인식 대상인지 계속 보여줍니다. 그리고 자동/
          수동에 상관없이 실제로 텍스트를 찾아낸 영역은 추출이 끝날 때마다 노란 반투명 +
          점선 테두리 사각형으로 3초간 표시됩니다. 그 사이엔 화면 상단에 "영역 탐지
          중...", "언어 감지 중...", "텍스트 추출 중..." 같은 진행 안내도 순서대로 뜹니다.
        </p>
        <p className="desc">
          유튜브·넷플릭스 자막, 일반 웹페이지, PDF(macOS 미리보기)는 화면을 캡처해 인식(OCR)
          하는 대신 원문 텍스트를 직접 읽어옵니다 — 더 정확하고 빠릅니다. 이 방식이 잘 안
          맞으면(예: 자막이 아닌 화면 요소를 잘못 잡음) 트레이 메뉴의 "OCR로 전환"으로 화면
          캡처 인식으로 강제 전환할 수 있습니다 — PDF는 양방향으로 다시 되돌릴 수도
          있습니다.
        </p>
      </section>

      <section className="settings-section">
        <h2>3. 팝업에서 뜻·발음 확인하기</h2>
        <p className="desc">
          클릭한 지점 근방의 텍스트가 자동으로 선택된 채로 팝업이 뜹니다. 원하는 범위로
          조정하려면 단어(또는 일본어/중국어는 "문자 단위 선택" 체크박스로 글자)를 클릭하면
          그 단위만, 드래그하면 지나간 범위 전체가 선택됩니다. 선택된 표현은 팝업이 뜰 때마다
          자동으로 클립보드에 복사됩니다.
        </p>
        <p className="desc">
          상단 툴바에는 발음(구글 발음 검색)/이미지(구글 이미지 검색) 버튼이 있고, 지원
          언어라면 사전(네이버 사전) 버튼도 있습니다 — 누르면 바로 브라우저 새 창으로
          열립니다. 오른쪽에는 AI 발음/AI 사전 버튼(1단계 언어만)이 있어 누르면 AI가 채팅
          영역에 답을 스트리밍으로 보여줍니다. AI 사전 옆의 드롭다운 + "직접 선택" 체크박스로
          특정 사전 소스 하나만 강제로 조회하게 할 수도 있습니다.
        </p>
        <p className="desc">
          채팅 하단 입력창에는 자유롭게 아무 질문이나 적어 보낼 수 있습니다. 자주 쓰는
          질문은 "자주 쓰는 질문" 목록에 "+ 추가"로 등록해두고, 클릭 한 번으로 바로 물어볼 수
          있습니다 — 드래그로 순서를 바꾸거나 수정·삭제도 가능합니다.
        </p>
        <p className="desc">
          스크롤하거나 페이지를 넘긴 뒤 클릭해도, 방금까지 보던 내용은 팝업 본문과 AI 문맥
          양쪽에 이어서 반영됩니다. 스크롤로 화면 일부가 밀려난 경우엔 겹치는 부분을 기준으로
          자연스럽게 이어붙이고, 아예 다음 페이지로 넘어가 겹치는 내용이 없을 때도 클릭한
          지점이 새 페이지의 맨 앞부분이면 직전 페이지의 끝부분을 그대로 이어붙입니다(영어
          등 띄어쓰기가 있는 언어는 사이에 공백 한 칸이 자동으로 들어갑니다).
        </p>
      </section>

      <section className="settings-section">
        <h2>4. PDF / EPUB / TXT 뷰어</h2>
        <p className="desc">
          메인 화면의 "PDF / EPUB / TXT 뷰어" 버튼으로 해당 확장자 파일을 열면 Nuance 자체
          뷰어 창이 뜹니다. 뷰어 상단의 "선택" 모드를 켜면 본문의 단어를 클릭해 위와 같은
          팝업을 바로 띄울 수 있고, "일반" 모드에서는 하이라이트 없이 그냥 읽기 전용으로
          쓸 수 있습니다.
        </p>
      </section>

      <section className="settings-section">
        <h2>5. 트레이 메뉴</h2>
        <p className="desc">
          작업표시줄/메뉴바의 Nuance 아이콘을 클릭하면 뜨는 메뉴로 대부분의 조작을 마우스
          없이도(단축키로) 할 수 있습니다. 창을 아직 선택하지 않았으면 "창 선택"만 보이고,
          이미 선택했으면 "창 선택 전환"/"창 선택 해제"가 대신 뜹니다. 선택 모드일 때는
          "영역 수동 선택"이 추가로 보이고, 자막/웹/PDF처럼 원문을 직접 읽는 중이면
          "OCR로 전환"(PDF는 "텍스트 추출로 전환"과 번갈아)이 뜹니다. 맨 아래엔 항상
          "설정"과 "종료"가 있습니다.
        </p>
      </section>

      <section className="settings-section">
        <div className="section-header">
          <h2>6. 단축키</h2>
          <button className="reset-btn" type="button" onClick={() => goto('settings')}>
            설정에서 변경
          </button>
        </div>
        <p className="desc">
          아래 표는 지금 저장된 실제 단축키 값입니다(설정 화면에서 바꾸면 여기도 함께
          바뀝니다). Shift만 걸고 문자 키를 조합하면(예: Shift+T) 그 문자 입력을 가로채
          타이핑이 깨지므로 등록할 수 없고, 다른 단축키와 겹치거나 OS·다른 앱의 필수
          단축키(Windows: Alt+F4, Ctrl+C 등 / macOS: Cmd+Q, Cmd+Space 등)와 겹치는 조합도
          등록이 막히고 이유가 안내됩니다.
        </p>
        {settings && (
          <table className="manual-shortcut-table">
            <tbody>
              {SHORTCUT_FIELDS.map((field) => (
                <tr key={field.key}>
                  <td>{field.label}</td>
                  <td>
                    <span className="shortcut-keys">{formatAccelerator(settings[field.key])}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-section">
        <h2>7. 텍스트 영역 자동 탐지</h2>
        <p className="desc">
          활성화 시 선택 모드로 전환을 하거나 선택 모드 내에서 창의 크기가 변할 때 자동으로
          텍스트 영역을 탐지합니다. 실제로 찾아낸 영역은 위 "2. 선택 모드로 텍스트 찾기"에서
          설명한 노란 점선 사각형으로 추출이 끝날 때마다 확인할 수 있습니다. 다만 자동
          탐지는 본문이 아닌 요소(메뉴·광고 등)까지 포함하는 노이즈가 섞일 수 있어서,
          결과가 마음에 안 들면 트레이 메뉴의 "영역 수동 선택"으로 언제든 직접 드래그해
          대체할 수 있습니다.
        </p>
      </section>

      <section className="settings-section">
        <h2>8. 언어 선택</h2>
        <p className="desc">
          자동: 자막/화면 텍스트로 언어를 매번 자동 판별합니다. 자막·웹 텍스트는 정확도가
          높지만, 화면 캡처(OCR) 판별은 폰트나 레이아웃에 따라 틀리는 경우가 있어 상대적으로
          정확도가 낮습니다. 자동 판별이 계속 틀리는 콘텐츠를 볼 때는 특정 언어를 선택해
          판별 자체를 건너뛰고 고정하세요.
        </p>
        <p className="desc">
          지원 범위는 3단계입니다 — <strong>1단계</strong>(영어·일본어·중국어): 언어 특화
          OCR · 사전 검색 · 특화된 발음 표기(히라가나/한어병음 등 그 언어 학습에 맞는 표기) ·
          형태소 분석기까지 전부 지원합니다. <strong>2단계</strong>: 범용 OCR과 IPA 발음,
          구글 발음 검색은 되지만 사전 검색 기능은 없습니다 — 그중 네이버 사전 연결까지 되는
          언어가 <strong>2단계(A)</strong>, 안 되는 언어가 <strong>2단계(B)</strong>입니다
          (설정 화면 드롭다운 목록에서 구분).
        </p>
      </section>

      <section className="settings-section">
        <h2>9. LLM · 사전 API 키</h2>
        <p className="desc">
          AI 발음/사전/통합 질문 기능은 GPT · Gemini · Claude 중 하나의 API 키가 있어야
          동작합니다. 설정 화면에서 provider를 고르고 키를 등록하면 사용 가능한 모델 목록을
          자동으로 확인해줍니다. 영어 사전 검색 품질을 높이려면 Merriam-Webster API 키를
          추가로 등록할 수 있습니다(비워두면 다른 사전으로 자동 대체). 키는 암호화되어
          저장되며 외부로 전송되지 않습니다.
        </p>
      </section>

      <section className="settings-section">
        <h2>10. 문맥 범위 (Byte)</h2>
        <p className="desc">
          선택한 표현 앞뒤로 AI에게 얼마나 넓은 문맥을 함께 보여줄지 바이트 단위로 정합니다.
          너무 좁으면 AI가 맥락을 놓치고, 너무 넓으면 요청 비용이 늘어납니다 — 앞/뒤를 각각
          다르게 두거나 하나로 묶어 관리할 수 있습니다.
        </p>
      </section>

      <p className="manual-note">
        더 궁금한 점이 있으면 설정 화면의 각 섹션 설명도 함께 참고하세요.
      </p>
    </div>
  )
}
