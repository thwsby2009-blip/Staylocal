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

export async function translateText(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  if (!text) return ''

  const result = await Translation.translate({
    text,
    sourceLanguage: sourceLanguage as Language,
    targetLanguage: targetLanguage as Language,
  })

  let output = result.text
  if (isChinese(targetLanguage)) {
    output = getTwConverter()(output)
  }
  return output
}

/** 簡體 → 台灣繁體（含詞彙轉換）：離線語音模型輸出簡體時使用 */
export function toTaiwanTraditional(text: string): string {
  return getTwConverter()(text)
}

/** 僅供測試：重置 converter 快取 */
export function resetConverterCacheForTests(): void {
  twConverter = null
}
