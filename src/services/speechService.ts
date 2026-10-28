import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * 語音聽寫服務：橋接自製 SpeechInputPlugin（Android 內建 SpeechRecognizer）。
 *
 * 定位：完全離線——原生層以 EXTRA_PREFER_OFFLINE=true 只用離線辨識引擎，
 * 零上傳，與本 app 的翻譯/OCR 同一原則。
 *
 * 事件模型（原生 → JS）：
 * - partialTranscript：辨識中的即時文字（當前段）
 * - finalTranscript：一段結束（手動停止／引擎自行結束／無語音／錯誤）
 */

export interface SpeechInputPlugin {
  checkAvailability(): Promise<{
    available: boolean
    speechActivities: string[]
    recognitionServices: string[]
    defaultService: string
  }>
  start(options: { language: string }): Promise<{ started: boolean }>
  stop(): Promise<void>
  addListener(
    eventName: 'partialTranscript',
    listenerFunc: (data: { text: string }) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle
  addListener(
    eventName: 'finalTranscript',
    listenerFunc: (data: FinalTranscriptEvent) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle
  removeAllListeners(): Promise<void>
}

export interface FinalTranscriptEvent {
  text: string
  reason: 'manual-stop' | 'engine-end' | 'no-match' | 'error'
  message?: string
}

export interface SpeechSessionResult {
  transcript: string
  reason: FinalTranscriptEvent['reason']
  message?: string
}

const SpeechInput = registerPlugin<SpeechInputPlugin>('SpeechInput')

/**
 * ML Kit 語言碼 → 語音辨識 BCP-47 locale。
 * 離線引擎的可用語言依裝置已下載的「裝置端語音辨識」資料而定；
 * 未列出的語言不提供錄音（MVP 以英文為主）。
 */
const SPEECH_LOCALES: Record<string, string> = {
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'cmn-Hant-TW',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-BR',
  ru: 'ru-RU',
  th: 'th-TH',
  vi: 'vi-VN',
  id: 'id-ID',
  nl: 'nl-NL',
  tr: 'tr-TR',
}

export function isSpeechSupported(langCode: string): boolean {
  return langCode in SPEECH_LOCALES
}

export function speechLocaleFor(langCode: string): string {
  return SPEECH_LOCALES[langCode] ?? 'en-US'
}

let availabilityCache: boolean | null = null

/** 原生語音辨識服務是否存在（瀏覽器預覽時回 false） */
export async function checkSpeechAvailability(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache
  try {
    const { available } = await SpeechInput.checkAvailability()
    availabilityCache = available
  } catch {
    availabilityCache = false
  }
  return availabilityCache
}

/** 診斷用：取回系統語音辨識元件清單（activity/服務/預設服務） */
export async function getSpeechDiagnostics(): Promise<{
  available: boolean
  speechActivities: string[]
  recognitionServices: string[]
  defaultService: string
} | null> {
  try {
    return await SpeechInput.checkAvailability()
  } catch {
    return null
  }
}

/** 測試用：重置可用性快取與監聽狀態 */
export function resetSpeechServiceForTests(): void {
  availabilityCache = null
  currentOnPartial = null
  currentOnFinal = null
  listenersRegistered = false
  listening = false
}

type PartialHandler = (text: string) => void
type FinalHandler = (result: SpeechSessionResult) => void

let currentOnPartial: PartialHandler | null = null
let currentOnFinal: FinalHandler | null = null
let listenersRegistered = false
let listening = false

async function ensureListeners(): Promise<void> {
  if (listenersRegistered) return
  await SpeechInput.addListener('partialTranscript', (data) => {
    currentOnPartial?.(data.text)
  })
  await SpeechInput.addListener('finalTranscript', (data) => {
    listening = false
    currentOnFinal?.({
      transcript: data.text,
      reason: data.reason,
      message: data.message,
    })
  })
  listenersRegistered = true
}

export function isDictating(): boolean {
  return listening
}

/**
 * 開始聽寫。啟動失敗會丟出帶使用者可讀訊息的錯誤。
 * onPartial 收當前段的即時文字；onFinal 在該段結束時收到結果（只會一次）。
 */
export async function startDictation(opts: {
  language: string
  onPartial: PartialHandler
  onFinal: FinalHandler
}): Promise<void> {
  if (listening) {
    throw new Error('已在錄音中')
  }
  const available = await checkSpeechAvailability()
  if (!available) {
    throw new Error('此裝置沒有可用的語音辨識服務')
  }
  await ensureListeners()
  currentOnPartial = opts.onPartial
  currentOnFinal = opts.onFinal
  try {
    await SpeechInput.start({ language: speechLocaleFor(opts.language) })
    listening = true
  } catch (e) {
    currentOnPartial = null
    currentOnFinal = null
    throw new Error(e instanceof Error ? e.message : '語音辨識啟動失敗')
  }
}

/** 停止聽寫：請求結束當前段，結果由 onFinal 送達 */
export async function stopDictation(): Promise<void> {
  if (!listening) return
  await SpeechInput.stop()
}
