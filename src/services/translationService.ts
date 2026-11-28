import { Translation, Language } from '@capacitor-mlkit/translation'
import * as OpenCC from 'opencc-js'

/**
 * 翻譯服務：ML Kit 端側翻譯 + OpenCC 繁化。
 *
 * ML Kit 的中文輸出固定是簡體，因此目標語言為中文時，
 * 一律經 OpenCC cn→twp（台灣用字 + 詞彙轉換，如 软件→軟體）。
 */

// OpenCC converter 建立成本高（載詞庫），模組級快取重複使用
let twConverter: ((text: string) => string) | null = null

function getTwConverter(): (text: string) => string {
  if (!twConverter) {
    twConverter = OpenCC.Converter({ from: 'cn', to: 'twp' })
  }
  return twConverter
}

export function isChinese(lang: string): boolean {
  return lang === Language.Chinese || lang.startsWith('zh')
}

/** 需要 CJK 空白清理的語言（日文／中文／粵語） */
export function isCjkLang(lang: string): boolean {
  return lang === 'ja' || lang.startsWith('zh') || lang === 'yue'
}

/**
 * 非英文語言對固定「經英文中繼」：X → 英文 → Y（最終輸出仍是 Y，通常是中文）。
 *
 * 為什麼明示中繼（實測 ML Kit 內部本來就經英文、結果一字不差）：
 * 使用者的需求是「日韓→英文→中文」——最終輸出中文，但**英文那一步要看得見**。
 * 因為中繼英文往往是整條鏈裡最可信的一段（實測韓→英 明顯優於任何中文路徑），
 * 中文讀不通時可以直接讀那一行英文，所以把英文透過 onIntermediate 交給 UI 顯示。
 */
export type TranslateOptions = {
  /** 走英文中繼時，取得中間英文（供 UI 顯示） */
  onIntermediate?: (english: string) => void
}

/** 是否走英文中繼：來源與目標都不是英文時 */
export function shouldRelayViaEnglish(source: string, target: string): boolean {
  return source !== Language.English && target !== Language.English
}

export async function translateText(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  options: TranslateOptions = {},
): Promise<string> {
  if (!text) return ''

  let output: string
  if (shouldRelayViaEnglish(sourceLanguage, targetLanguage)) {
    const viaEn = await Translation.translate({
      text,
      sourceLanguage: sourceLanguage as Language,
      targetLanguage: Language.English,
    })
    options.onIntermediate?.(viaEn.text)
    const result = await Translation.translate({
      text: viaEn.text,
      sourceLanguage: Language.English,
      targetLanguage: targetLanguage as Language,
    })
    output = result.text
  } else {
    const result = await Translation.translate({
      text,
      sourceLanguage: sourceLanguage as Language,
      targetLanguage: targetLanguage as Language,
    })
    output = result.text
  }

  if (isChinese(targetLanguage)) {
    output = getTwConverter()(output)
  }
  // 極短輸入（單一英文詞）的詞義修正：ML Kit 短輸入會選錯最高頻詞義（Move→搬家）
  const shortFix = fixShortInputTranslation(text, output)
  if (shortFix) output = shortFix
  return output
}

/** 簡體 → 台灣繁體（含詞彙轉換）：離線語音模型輸出簡體時使用 */
export function toTaiwanTraditional(text: string): string {
  return getTwConverter()(text)
}

/**
 * 極短片段（單字／兩詞以下）的 ML Kit 詞義修正表。
 *
 * 背景：ML Kit 是統計翻譯，輸入越短越依賴訓練語料的最高頻詞義。
 * 單獨出現的「Move」在生活語料裡最高頻的詞義是「搬家」，但字幕／對白場景
 * 單獨一句的「Move!」幾乎都是祈使句（移動／走開）。只對「極短、無上下文」
 * 的片段套用此表——句子級翻譯不碰（語境詞義該由句子決定，靜態替換會把
 * 「I'm moving next week」的 moving 改錯）。
 *
 * 維護方式：從實測的 livePair log（logcat 可拉原文＋譯文對照）發現單字
 * 高頻錯譯就加一條；只收「錯譯明顯多於正譯」的條目，寧缺勿濫。
 */
const SHORT_INPUT_FIXES: Record<string, string> = {
  // 英文原詞（小寫比對）→ 修正譯文
  move: '移動',
  run: '跑',
  drive: '開車',
  play: '播放',
  watch: '看',
  mean: '意思是',
  right: '對',
  left: '左邊',
  stop: '停',
  wait: '等等',
}

/**
 * 極短輸入的詞義修正：只處理「單一英文詞（可帶標點）」的輸入。
 * 回傳 null 表示不適用（長句、非表內單字），呼叫端沿用 ML Kit 原譯文。
 */
export function fixShortInputTranslation(sourceText: string, translated: string): string | null {
  const m = sourceText.trim().match(/^[a-zA-Z]+[!.?]?$/)
  if (!m) return null
  const fix = SHORT_INPUT_FIXES[sourceText.trim().toLowerCase().replace(/[!.?]$/, '')]
  return fix ? fix : null
}

/**
 * 清理 CJK 語音辨識輸出：SenseVoice 的日中輸出會夾雜不自然的空格
 * （詞間空白、甚至把詞切開，如「使わ な いから」）。日文與中文正常不這樣寫，
 * 這種字串餵給翻譯模型會明顯拉低品質（時態、漏譯、直譯）。
 * 只移除「非 ASCII 字元之間」的空白，不動拉丁字母（如 YouTube）周圍的空白。
 */
export function tidyCjk(text: string): string {
  if (!text) return ''
  return text
    .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 僅供測試：重置 converter 快取 */
export function resetConverterCacheForTests(): void {
  twConverter = null
}
