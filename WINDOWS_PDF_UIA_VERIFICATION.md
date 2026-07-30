# Windows UIA로 크롬 PDF 뷰어 텍스트+좌표 추출 가능한지 실측

이 문서는 Windows 환경을 가진 팀원(및 그 팀원의 Claude)에게 실측을 맡기기 위한 작업 지시서다.
윈도우 개발 환경이 없어 이 저장소의 macOS 세션에서는 여기까지만 확인했고, 아래 스크립트로
실측한 뒤 결과를 이 문서 하단과 `TODO.md`에 반영해달라.

## 배경

`TODO.md`(96~103번 줄 근방)에 정리돼 있듯, 브라우저(크롬)에서 연 PDF에 호버박스를 띄우려던
원래 계획("확장 프로그램으로 텍스트 레이어 직접 추출")은 불가능한 것으로 판명됐다 — 크롬
내장 PDF 뷰어는 다른 확장 origin의 페이지이고, PDFium이 캔버스에 픽셀로만 그려서 DOM
텍스트 노드 자체가 없다.

대안으로 macOS에서 접근성 API(AX)를 크롬 창에 직접 시도해본 결과는 **성공**이었다:

- 크롬 창의 AX 트리를 깊이 제한 없이 순회하면(중첩된 `AXWebArea`가 3겹, 깊이 ~24), PDF
  본문이 실제로 `AXStaticText` 노드로 노출된다(예: 4,701개 노드, 텍스트가 실제 페이지 내용과
  정확히 일치).
- 각 노드가 `AXBoundsForRange`/`AXStringForRange` 파라미터 속성을 지원하고, opaque
  `AXTextMarker`가 아니라 **단순 `CFRange`(정수 인덱스) 기반**이라 문자 범위(0,5)만 넘겨도
  그 부분 문자열의 정확한 화면 좌표(CGRect)가 나온다. 노드 자신의 `AXPosition`/`AXSize`는
  멀티라인 텍스트에서 왜곡되므로 신뢰하면 안 되고, 항상 `AXBoundsForRange`로 원하는 범위를
  직접 질의해야 한다는 것도 확인했다(macOS Preview.app 조사 때와 동일한 결론).

크롬의 접근성 트리는 내부적으로 하나의 공용 표현(Chromium accessibility tree)을 갖고 이걸
macOS엔 AX로, Windows엔 UI Automation(UIA)으로 내보낸다. 구조상 Windows에서도 같은 정보가
노출될 가능성이 높지만, **추측이 아니라 실측이 필요하다** — 이게 이 문서의 목적이다.

## 확인해야 할 것 (Go/No-Go 판정 기준)

1. 크롬으로 텍스트 레이어가 있는 PDF(스캔본 아님, 실제 텍스트 선택/검색이 되는 PDF)를 열었을
   때, UIA 트리에서 PDF 본문이 `ControlType.Text` 또는 `ControlType.Document` 등으로 노출되고
   실제 텍스트 내용을 담고 있는가? (macOS의 `AXStaticText` 4,701개에 대응하는 것)
2. 그 요소가 `TextPattern`(또는 `TextPattern2`)을 지원하는가?
3. `TextPattern.DocumentRange`에서 부분 범위(예: 앞 5글자)를 잘라 `GetText()`/
   `GetBoundingRectangles()`를 호출했을 때, **문자열도 맞고 좌표도 실제 화면상의 그 글자
   위치를 가리키는 진짜 값**이 나오는가? (Kindle for Mac처럼 "성공은 하지만 항상 크기 0짜리
   자리표시자만 주는" 가짜 응답이 아닌지가 핵심 — macOS Preview.app 조사에서 Kindle이 바로
   이 증상으로 탈락했다)
4. (선택) 관리자 권한으로 뜬 크롬을 일반 권한 스크립트로 조회하면 UIPI에 막혀 실패하는지도
   같이 확인해두면 좋다 — 이후 앱이 크롬과 같은 권한 레벨로 떠야 하는지 판단 근거가 된다.

3번이 "진짜 좌표"로 확인되면 Go, "자리표시자"거나 애초에 텍스트 자체가 안 잡히면 No-Go다.

## 실측 방법

### 준비물
- Windows PC, Google Chrome 설치
- 텍스트 레이어가 있는 PDF 파일 하나(예: 아무 논문 PDF — 크롬에서 Ctrl+F로 검색해 하이라이트가
  잡히면 텍스트 레이어가 있는 것)
- PowerShell (Windows 기본 내장 `powershell.exe`로 충분, 관리자 권한 불필요)

### 절차
1. 크롬으로 그 PDF 파일을 연다(파일 탐색기에서 더블클릭하거나 크롬 주소창에 `file:///...pdf`
   경로 직접 입력). 다른 탭은 다 닫아서 `Get-Process chrome`이 헷갈리지 않게 한다.
2. 아래 `probe_chrome_pdf_uia.ps1` 스크립트를 그대로 저장해서 실행한다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\probe_chrome_pdf_uia.ps1
   ```
3. 출력에서 위 "확인해야 할 것" 1~3번에 해당하는 내용을 확인한다.

### 스크립트: `probe_chrome_pdf_uia.ps1`

```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $chrome) {
    Write-Error "크롬 창을 찾을 수 없습니다. 크롬으로 PDF를 열어둔 채로 다시 실행하세요."
    exit 1
}
Write-Host "Chrome pid: $($chrome.Id), MainWindowHandle: $($chrome.MainWindowHandle)"

$root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)

$roleCounts = @{}
$textPatternHolders = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
$maxDepthSeen = 0

function Walk-Tree {
    param($element, $depth)

    $ct = $element.Current.ControlType.ProgrammaticName
    if (-not $roleCounts.ContainsKey($ct)) { $roleCounts[$ct] = 0 }
    $roleCounts[$ct]++

    if ($depth -gt $script:maxDepthSeen) { $script:maxDepthSeen = $depth }

    $patterns = $element.GetSupportedPatterns()
    $hasText = $patterns | Where-Object { $_.ProgrammaticName -like "TextPattern*" }
    if ($hasText -and $textPatternHolders.Count -lt 10) {
        $textPatternHolders.Add($element)
    }

    if ($depth -ge 40) { return }
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($child in $children) {
        Walk-Tree -element $child -depth ($depth + 1)
    }
}

Write-Host "`n=== 트리 순회 시작 (시간이 걸릴 수 있음) ==="
Walk-Tree -element $root -depth 0

Write-Host "`n=== ControlType별 개수 ==="
$roleCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host "$($_.Key): $($_.Value)"
}
Write-Host "`n최대 깊이: $maxDepthSeen"

Write-Host "`n=== TextPattern 지원 요소 (최대 10개) ==="
foreach ($el in $textPatternHolders) {
    $name = $el.Current.Name
    $ct = $el.Current.ControlType.ProgrammaticName
    Write-Host "`n--- $ct / Name=`"$name`" ---"

    $textPattern = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $docRange = $textPattern.DocumentRange
    $fullText = $docRange.GetText(500)
    Write-Host "본문 앞부분(500자): $fullText"

    if ([string]::IsNullOrWhiteSpace($fullText)) { continue }

    # 앞 5글자만 잘라내는 부분 범위 테스트 — macOS AXBoundsForRange(0,5)와 대응
    $range = $docRange.Clone()
    $range.MoveEndpointByRange(
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
        $docRange,
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
    )
    $range.MoveEndpointByUnit(
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
        [System.Windows.Automation.Text.TextUnit]::Character,
        5
    )
    $subText = $range.GetText(-1)
    $rects = $range.GetBoundingRectangles()

    Write-Host "부분 범위(앞 5글자) 텍스트: `"$subText`""
    Write-Host "부분 범위 좌표(GetBoundingRectangles):"
    foreach ($r in $rects) {
        Write-Host "  X=$($r.X) Y=$($r.Y) W=$($r.Width) H=$($r.Height)"
    }
}
```

## 결과를 어떻게 보고할지

1. 이 문서 하단에 "## 실측 결과" 섹션을 추가해서 스크립트 출력(특히 위 4가지 판정 기준에
   대한 답)을 그대로 붙여넣는다. 스크린샷도 괜찮다.
2. Go로 판정되면 `TODO.md`의 96~103번 줄 근방(브라우저 PDF 계획 변경 항목)에 "Windows UIA도
   확인됨" 문구를 추가하고, No-Go면 왜 안 되는지(텍스트 자체가 안 잡히는지, 좌표만 가짜인지)
   구체적으로 남긴다 — macOS 조사에서 Kindle이 탈락한 이유를 기록해둔 것과 같은 톤으로.
3. 변경사항은 `dev` 브랜치에 커밋 후 바로 push한다(이 저장소의 커밋 컨벤션 — `CLAUDE.md`
   참고. 로컬에 `CLAUDE.md`가 없다면 팀 채널에서 공유받은 컨벤션을 따르면 된다: 커밋 메시지는
   `<type>: <설명>` 형식, 설명은 한국어).

## 참고: GUI로 먼저 눈으로 확인하고 싶다면

스크립트가 부담스러우면, 마이크로소프트가 무료 배포하는 **Accessibility Insights for
Windows**([accessibilityinsights.io](https://accessibilityinsights.io/)) 앱으로 크롬 PDF
화면 위에서 UIA 트리를 실시간으로 마우스 오버하며 눈으로 먼저 확인해볼 수 있다. "Live Watch"
모드로 PDF 텍스트 위에 마우스를 올렸을 때 `ControlType`이 텍스트 관련으로 잡히는지, `Text
Pattern`이 지원 패턴 목록에 뜨는지만 봐도 대략적인 감을 잡을 수 있다 — 다만 최종 판정은 위
스크립트의 `GetBoundingRectangles()` 실측(진짜 좌표 vs 자리표시자)으로 내려야 한다.
