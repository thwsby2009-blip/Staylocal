/**
 * 語言清單（2026/11/24 依 ASR 品質重整）。
 *
 * tier 說明（依 OpenAI Whisper 論文 FLEURS 實測 WER + 母語人口篩選）：
 * - 'sv'   SenseVoice 高品質離線辨識（zh/en/ja/ko/yue 五語言專屬）
 * - 'good' Whisper small WER < 25% 且族群 ≥ 2500 萬 → 語音翻譯可用
 * - 'edge' 品質勉強（WER 25-40%）或族群小 → 文字翻譯可用，語音不掛保證
 * - 已移除：Whisper 全尺寸 WER > 35% 的語言（te/kn/ml/bn/gu/ta/ur/he/fa/mr/
 *   sl/lv/lt/af/be/cy/sw 等）——紙面支援但語音輸出不可用，列了誤導使用者
 */
export type LangTier = 'sv' | 'good' | 'edge'
export const LANGUAGES: { code: string; name: string; tier: LangTier }[] = [
  { code: 'zh', name: '中文（輸出簡體，自動轉繁體）', tier: 'sv' },
  { code: 'en', name: '英文', tier: 'sv' },
  { code: 'ja', name: '日文', tier: 'sv' },
  { code: 'ko', name: '韓文', tier: 'sv' },
  // yue（粵語）不在 LANGUAGES：ML Kit Translation 無 Cantonese，無法翻成目標語言；
  // SenseVoice 雖支援 yue 辨識，但翻譯層斷鏈。粵語辨識需求走 zh 或 App 外處理。
  { code: 'es', name: '西班牙文', tier: 'good' },
  { code: 'fr', name: '法文', tier: 'good' },
  { code: 'pt', name: '葡萄牙文', tier: 'good' },
  { code: 'ru', name: '俄文', tier: 'good' },
  { code: 'de', name: '德文', tier: 'good' },
  { code: 'it', name: '義大利文', tier: 'good' },
  { code: 'id', name: '印尼文', tier: 'good' },
  { code: 'tr', name: '土耳其文', tier: 'good' },
  { code: 'vi', name: '越南文', tier: 'good' },
  { code: 'th', name: '泰文', tier: 'good' },
  { code: 'ms', name: '馬來文', tier: 'good' },
  { code: 'pl', name: '波蘭文', tier: 'good' },
  { code: 'uk', name: '烏克蘭文', tier: 'good' },
  { code: 'nl', name: '荷蘭文', tier: 'good' },
  { code: 'ar', name: '阿拉伯文（語音實驗性）', tier: 'edge' },
  { code: 'hi', name: '印地文（語音實驗性）', tier: 'edge' },
  { code: 'ro', name: '羅馬尼亞文（語音實驗性）', tier: 'edge' },
  { code: 'el', name: '希臘文（語音實驗性）', tier: 'edge' },
  { code: 'da', name: '丹麥文（語音實驗性）', tier: 'edge' },
  { code: 'no', name: '挪威文（語音實驗性）', tier: 'edge' },
  { code: 'sv', name: '瑞典文（語音實驗性）', tier: 'edge' },
  { code: 'fi', name: '芬蘭文（語音實驗性）', tier: 'edge' },
  { code: 'cs', name: '捷克文（語音實驗性）', tier: 'edge' },
  { code: 'sk', name: '斯洛伐克文（語音實驗性）', tier: 'edge' },
  { code: 'hr', name: '克羅埃西亞文（語音實驗性）', tier: 'edge' },
  { code: 'hu', name: '匈牙利文（語音實驗性）', tier: 'edge' },
  { code: 'he', name: '希伯來文（語音實驗性）', tier: 'edge' },
]

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code
}
