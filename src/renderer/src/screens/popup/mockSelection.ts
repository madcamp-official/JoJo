import type { ExtractedSelection } from '@shared/types'

// ============================================================================
// 담당 B — 팝업 개발용 목업 (호빗 첫 페이지, "well-to-do" 클릭 상황)
//
// ⚠️ 임시 fixture. 담당 A 의 선택 파이프라인이 실제 ExtractedSelection 을 만들어
//    createPopupWindow(ctx) 로 넘기면 이 목업은 자연스럽게 대체된다.
//    (팝업 렌더러는 실제 ctx 가 없을 때만 이 목업으로 fallback 한다.)
//
// text 는 원문 전체를 그대로 담는다 — 표시 범위(선택 앞뒤 1024바이트 + 문장 경계
// 확장)는 팝업이 buildSelectionModel(@renderer/screens/popup/selection.ts)에서
// 잘라내므로, 여기서는 A 의 실제 추출 결과처럼 트리밍 없이 넘기기만 하면 된다.
// ============================================================================

/** 호빗 첫 페이지 원문 (담당 A 가 PDF 에서 추출했다고 가정한 전체 텍스트) */
export const HOBBIT_TEXT = [
  'In a hole in the ground there lived a hobbit. Not a nasty, dirty, wet hole, filled with the ends of worms and an oozy smell, nor yet a dry, bare, sandy hole with nothing in it to sit down on or to eat: it was a hobbit-hole, and that means comfort.',
  'It had a perfectly round door like a porthole, painted green, with a shiny yellow brass knob in the exact middle. The door opened on to a tube-shaped hall like a tunnel: a very comfortable tunnel without smoke, with panelled walls, and floors tiled and carpeted, provided with polished chairs, and lots and lots of pegs for hats and coats—the hobbit was fond of visitors. The tunnel wound on and on, going fairly but not quite straight into the side of the hill—The Hill, as all the people for many miles round called it—and many little round doors opened out of it, first on one side and then on another. No going upstairs for the hobbit: bedrooms, bathrooms, cellars, pantries (lots of these), wardrobes (he had whole rooms devoted to clothes), kitchens, dining-rooms, all were on the same floor, and indeed on the same passage. The best rooms were all on the left-hand side (going in), for these were the only ones to have windows, deep-set round windows looking over his garden, and meadows beyond, sloping down to the river.',
  'This hobbit was a very well-to-do hobbit, and his name was Baggins. The Bagginses had lived in the neighbourhood of The Hill for time out of mind, and people considered them very respectable, not only because most of them were rich, but also because they never had any adventures or did anything unexpected: you could tell what a Baggins would say on any question without the bother of asking him. This is a story of how a Baggins had an adventure, and found himself doing and saying things altogether unexpected. He may have lost the neighbours’ respect, but he gained—well, you will see whether he gained anything in the end.',
].join('\n')

/** 사용자가 클릭한 표현(하이픈으로 묶인 하나의 표현) */
export const HOBBIT_TARGET = 'well-to-do'

/**
 * 전체 원문에서 target 을 찾아 anchor(초기 선택)로 표시한 ExtractedSelection 을
 * 조립한다(A가 넘길 형태 — 트리밍 없이 원문 그대로).
 */
export function buildExtractedSelection(
  full: string,
  target: string,
  opts?: {
    language?: ExtractedSelection['language']
    source?: ExtractedSelection['source']
    /** 단어 분리 방식 — 기본은 공백 기준(영어). 중/일 데모는 글자 단위로 넘긴다. */
    splitWords?: (text: string) => string[]
    /** target 이 원문에 여러 번 나올 때 몇 번째(0-based) 등장을 anchor 로 쓸지 지정 */
    occurrence?: number
  },
): ExtractedSelection {
  let targetPos = -1
  const occurrence = opts?.occurrence ?? 0
  let searchFrom = 0
  for (let i = 0; i <= occurrence; i++) {
    targetPos = full.indexOf(target, searchFrom)
    if (targetPos < 0) break
    searchFrom = targetPos + target.length
  }
  if (targetPos < 0) throw new Error(`target(${target}) 를 원문에서 찾지 못했습니다.`)

  const splitWords = opts?.splitWords ?? ((t: string) => t.split(/\s+/).filter(Boolean))

  return {
    text: full,
    anchor: { start: targetPos, end: targetPos + target.length },
    words: splitWords(full).map((t) => ({ text: t })),
    language: opts?.language ?? 'en',
    source: opts?.source ?? { kind: 'pdf', appName: 'Hobbit.pdf' },
    extraction: 'direct',
  }
}

/** 팝업이 실제 ctx 없이 열렸을 때 쓰는 기본 목업 추출 결과 */
export function mockHobbitExtraction(): ExtractedSelection {
  return buildExtractedSelection(HOBBIT_TEXT, HOBBIT_TARGET)
}

// ============================================================================
// 일본어 데모 목업 — 《容疑者Xの献身》(히가시노 게이고) 발췌, "眺めながら" 클릭 상황
// 세로쓰기 지면(사진)에서 옮긴 것 — 문단 단위로 이어 붙였다.
// ============================================================================

const DEVOTION_PARAGRAPHS = [
  '午前七時三十五分、石神はいつものようにアパートを出た。三月に入ったとはいえ、まだ風はかなり冷たい。マフラーに顎を埋めるようにして歩きだした。通りに出る前に、ちらりと自転車置き場に目を向けた。そこには数台並んでいたが、彼が気にかけている緑色の自転車はなかった。',
  '南に二十メートルほど歩いたところで、太い道路に出た。左に、つまり東へ進めば江戸川区に向かい、西へ行けば日本橋に出る。日本橋の手前には隅田川があり、それを渡るのが新大橋だ。',
  '石神の職場へ行くには、このまま真っ直ぐ南下するのが最短だ。数百メートル行けば、清澄庭園という公園に突き当たる。その手前にある私立高校が彼の職場だった。つまり彼は教師だった。数学を教えている。',
  '目の前の信号が赤になるのを見て、右に曲がった。新大橋に向かって歩いた。向かい風の中、足を送りだした。',
  '厚い雲が空を覆っていた。その色を反射させ、隅田川も濁った色に見えた。小さな船が上流に向かって進んでいく。それを眺めながら石神は新大橋を渡った。',
  '橋を渡ると、彼は袂にある階段を下りていった。橋の下をくぐり、隅田川に沿って歩き始めた。川の両側には遊歩道が作られている。もっとも、家族連れやカップルが散歩を楽しむのは、この先の清洲橋あたりからで、新大橋の近くには休日でもあまり人が近寄らない。その理由はこの場所に来てみればすぐにわかる。青いビニールシートに覆われたホームレスたちの住まいが、ずらりと並んでいるからだ。すぐ上を高速道路が通っているので反対側には青い小屋など一つもない。もちろん、彼等なりに集団を形成しておいたほうが何かと都合がいい、という事情もあるのだろう。',
  '青い小屋の前を石神は淡々と歩き続けた。それらの大きさはせいぜい人間の背丈ほどで、中には腰ぐらいの高さしかないものもあった。小屋というより箱と呼んだほうがふさわしい。しかし中で寝るだけなら、それで十分なのかもしれない。小屋や箱の近くには、申し合わせたように洗濯ハンガーが吊されており、ここが生活空間であることを物語っていた。',
  '堤防の端に作られた手すりにもたれ、歯を磨いている男がいた。石神がよく見かける男だった。年齢は六十歳以上、白髪混じりの髪を後ろで縛っている。働く気は、もうないのだろう。仕事を紹介されて肉体労働をするつもりなら、こんな時間にうろうろしていない。そうした仕事の斡旋が行われるのは早朝だ。また、職安に行く予定もないのだろう。',
]

/** 《容疑者Xの献身》발췌 원문(문단 사이만 '\n') */
export const DEVOTION_TEXT = DEVOTION_PARAGRAPHS.join('\n')

/** 사용자가 클릭한 표현 — "それを眺めながら石神は新大橋を渡った。" 의 新大橋 (3번째 등장) */
export const DEVOTION_TARGET = '新大橋'
const DEVOTION_TARGET_OCCURRENCE = 2

/** 일본어도 중국어처럼 글자 단위로 단어를 취급한다(공백으로 안 나뉘므로). */
function splitJapaneseWords(text: string): string[] {
  return text.match(/[一-鿿㐀-䶿぀-ヿ]/g) ?? []
}

/** 일본어 데모(팝업 미리보기)가 ctx 없이 열렸을 때 쓰는 목업 추출 결과 */
export function mockDevotionExtraction(): ExtractedSelection {
  return buildExtractedSelection(DEVOTION_TEXT, DEVOTION_TARGET, {
    language: 'ja',
    source: { kind: 'pdf', appName: '容疑者Xの献身.pdf' },
    splitWords: splitJapaneseWords,
    occurrence: DEVOTION_TARGET_OCCURRENCE,
  })
}

// ============================================================================
// 중국어(간체) 데모 목업 — 《三体》(류츠신) 발췌, "天线" 클릭 상황
// 원문은 줄바꿈 폭에 맞춰 강제 개행되어 있던 것을 문단 단위로 다시 이어 붙였다
// (문단 사이만 '\n', Hobbit 목업과 동일한 형식).
// ============================================================================

const THREE_BODY_PARAGRAPHS = [
  '杨冬出生后，在红岸基地，时间在紧张和平静中又过去了两年多。这时，叶文洁接到了通知，她和父亲的案件都被彻底平反；不久之后又收到了母校的信，说她可以立刻回去工作。与信同来的还有一大笔汇款，这是父亲落实政策后补发的工资。在基地会议上，领导终于称她为叶文洁同志了。',
  '叶文洁很平静地面对这一切，没有激动和兴奋。她对外面的世界不感兴趣，宁愿一直在僻静的红岸基地待下去，但为了孩子的教育，她还是离开了本以为要度过一生的红岸基地，返回了母校。',
  '走出深山，叶文洁充满了春天的感觉，“文革”的严冬确实结束了，一切都在复苏之中。虽然浩劫刚刚结束，举目望去一片废墟，无数人在默默地舔着自己的伤口，但在人们眼中，未来新生活的曙光已经显现。大学中出现了带着孩子的学生，书店中文学名著被抢购一空，工厂中的技术革新成了一件最了不起的事情，科学研究更是被罩上了一层神圣的光环。科学和技术一时成了打开未来之门的唯一钥匙，人们像小学生那样真诚地接近科学，他们的奋斗虽是天真的，但也是脚踏实地的。在第一次全国科学大会上，郭沫若宣布科学的春天到来了。',
  '这是疯狂的终结吗？科学和理智开始回归了？叶文洁不止一次地问自己。',
  '直到离开红岸基地，叶文洁再也没有收到来自三体世界的消息。她知道，要想收到那个世界对她那条信息的回答，最少要等八年，何况她离开了基地后，已经不具备接收外星回信的条件了。',
  '那件事实在太重大了，却由她一个人静悄悄地做完，这就产生了一种不真实的感觉。随着时间的流逝，这种虚幻感越来越强烈，那件事越来越像自己的幻觉，像一场梦。太阳真的能够放大电波吗？她真的把太阳作为天线，向宇宙中发射过人类文明的信息吗？真的收到过外星文明的信息吗？她背叛整个人类文明的那个血色清晨真的存在过？还有那一次谋杀……',
  '叶文洁试着在工作中麻木自己，以便忘掉过去——她竟然几乎成功了，一种奇怪的自我保护本能使她不再回忆往事，不再想起她与外星文明曾经有过的联系，日子就这样在平静中一天天过去。',
  '回到母校一段时间后，叶文洁带着冬冬去了母亲绍琳那里。丈夫惨死后，绍琳很快从精神错乱中恢复过来，继续在政治夹缝中求生存。她紧跟形势高喊口号，终于得到了一点报偿，在后来的“复课闹革命”中重新走上了讲台。但这时，绍琳却做出了一件出人意料的事，与一位受迫害的教育部高干结了婚，当时那名高干还在干校住“牛棚”劳改中。',
  '对此绍琳有自己的深思熟虑，她心里清楚，社会上的混乱不可能长久，目前这帮夺权的年轻造反派根本没有管理国家的经验，现在靠边站和受迫害的这批老干部迟早还是要上台执政的。后来的事实证明她这次赌博是正确的，“文革”还没有结束，她的丈夫已经部分恢复了职位，十一届三中全会后，他迅速升到了副部级。绍琳凭着这个背景，在这知识分子重新得到礼遇的时候，很快青云直上。在成为科学院学部委员之后，她很聪明地调离了原来的学校，很快升为另一所名牌大学的副校长。',
  '叶文洁见到的母亲，是一位保养得很好的知识女性形象，丝毫没有过去受磨难的痕迹。她热情地接待了叶文洁母女，关切地询问她这些年是怎么过来的，惊叹冬冬是多么的聪明可爱，细致入微地对做饭的保姆交待叶文洁喜欢吃的菜……这一切都做得那么得体，',
]

/** 《三体》발췌 원문(문단 사이만 '\n') */
export const THREE_BODY_TEXT = THREE_BODY_PARAGRAPHS.join('\n')

/** 사용자가 클릭한 표현 */
export const THREE_BODY_TARGET = '天线'

/** 한자를 한 글자씩(문장부호·공백 제외) 단어로 취급 — 중국어는 공백으로 단어가 안 나뉜다. */
function splitChineseWords(text: string): string[] {
  return text.match(/[一-鿿㐀-䶿]/g) ?? []
}

/** 중국어 데모(팝업 미리보기)가 ctx 없이 열렸을 때 쓰는 목업 추출 결과 */
export function mockThreeBodyExtraction(): ExtractedSelection {
  return buildExtractedSelection(THREE_BODY_TEXT, THREE_BODY_TARGET, {
    language: 'zh-Hans',
    source: { kind: 'pdf', appName: '三体.pdf' },
    splitWords: splitChineseWords,
  })
}
