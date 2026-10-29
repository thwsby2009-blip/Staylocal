import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * 語音聽寫服務：橋接自製 SpeechInputPlugin。
 *
 * 架構（批次，2026-10-29 定案）：**先錄音成檔案 → 停止後再轉逐字稿**。
 * 不以即時串流辨識（端側引擎在舊機上分段重啟不可靠）。
 *
 * 定位：完全離線——錄音走 AudioRecord，轉寫把 WAV 檔餵給端側辨識器
 * （API 33+ 的 EXTRA_AUDIO_SOURCE），音訊不離開裝置。
 *
 * 事件：transcribeFile 進行中會持續送 partialTranscript（逐字稿即時長出來）。
 */

export interface SpeechSupportInfo {
  onDeviceAvailable: boolean
  installedOnDeviceLanguages: string[]
  pendingOnDeviceLanguages: string[]
  supportedOnDeviceLanguages: string[]
  onlineLanguages: string[]
  error: string
}

export interface SpeechInputPlugin {
  checkAvailability(): Promise<{
    available: boolean
    speechActivities: string[]
    recognitionServices: string[]
    defaultService: string
  }>
  checkSupport(): Promise<SpeechSupportInfo>
  downloadOnDeviceModel(options: { language: string }): Promise<{
    triggered: boolean
    message: string
  }>
  /** 開始錄音（16kHz WAV，存 app 快取） */
  startRecording(options: Record<string, never>): Promise<{
    started: boolean
    path: string
  }>
  /** 停止錄音：回傳音檔路徑與長度 */
  stopRecording(): Promise<{ path: string; bytes: number; seconds: number }>
  /** 把音檔交給端側辨識器轉逐字稿（離線） */
  transcribeFile(options: { path: string; language: string }): Promise<{
    text: string
  }>
  addListener(
    eventName: 'partialTranscript',
    listenerFunc: (data: { text: string }) => void,
  ): Promise<PluginListenerHandle> & PluginListenerHandle
  removeAllListeners(): Promise<void>
}

const SpeechInput = registerPlugin<SpeechInputPlugin>('SpeechInput')

/**
 * ML Kit 語言碼 → 語音辨識 BCP-47 locale。
 * 端側引擎的可用語言依裝置已下載的模型而定（App 會自動查詢/觸發下載）。
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

/** 官方支援查詢（API 33+）：端側語言已安裝／可下載清單 */
export async function getSpeechSupportInfo(): Promise<SpeechSupportInfo | null> {
  try {
    return await SpeechInput.checkSupport()
  } catch {
    return null
  }
}

/** 觸發端側語言模型下載（需網路），回傳可顯示訊息 */
export async function triggerOnDeviceModelDownload(
  language: string,
): Promise<string | null> {
  try {
    const r = await SpeechInput.downloadOnDeviceModel({ language })
    return r.message ?? null
  } catch {
    return null
  }
}

/** 原生端可能把清單序列化成字串，一律正規化為陣列 */
export function toLangList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') {
    return v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/** 把支援查詢結果排成可讀多行文字 */
export function formatSupportInfo(info: SpeechSupportInfo): string {
  const j = (a: unknown) => {
    const list = toLangList(a)
    return list.length ? list.join('、') : '（無）'
  }
  return [
    `端側辨識服務=${info.onDeviceAvailable ? '有' : '無'}`,
    `已安裝=${j(info.installedOnDeviceLanguages)}`,
    `待下載=${j(info.pendingOnDeviceLanguages)}`,
    `可下載=${j(info.supportedOnDeviceLanguages)}`,
    `線上=${j(info.onlineLanguages)}`,
    info.error ? `查詢錯誤=${info.error}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// ===== 批次錄音 → 轉逐字稿 =====

let recording = false
let listenersRegistered = false
let partialHandler: ((text: string) => void) | null = null

/** 測試用：重置模組狀態 */
export function resetSpeechServiceForTests(): void {
  availabilityCache = null
  recording = false
  listenersRegistered = false
  partialHandler = null
}

async function ensureListeners(): Promise<void> {
  if (listenersRegistered) return
  await SpeechInput.addListener('partialTranscript', (data) => {
    partialHandler?.(String(data?.text ?? ''))
  })
  listenersRegistered = true
}

export function isRecordingNow(): boolean {
  return recording
}

/**
 * 開始錄音（不辨識）。onPartialText 只會在稍後轉寫階段被呼叫（顯示逐字稿進度）。
 * 啟動失敗丟出使用者可讀訊息。
 */
export async function startRecording(
  onPartialText?: (text: string) => void,
): Promise<void> {
  if (recording) throw new Error('已在錄音中')
  const available = await checkSpeechAvailability()
  if (!available) {
    throw new Error('此裝置沒有可用的語音辨識服務')
  }
  await ensureListeners()
  partialHandler = onPartialText ?? null
  try {
    await SpeechInput.startRecording({})
    recording = true
  } catch (e) {
    partialHandler = null
    throw new Error(e instanceof Error ? e.message : '錄音啟動失敗')
  }
}

/**
 * 停止錄音並轉逐字稿（整段一次轉，非即時）。
 * 回傳 { text, seconds }；轉寫失敗會丟錯（帶原生訊息）。
 */
export async function stopRecordingAndTranscribe(
  language: string,
): Promise<{ text: string; seconds: number }> {
  if (!recording) throw new Error('沒有進行中的錄音')
  recording = false
  const stopped = await SpeechInput.stopRecording()
  try {
    const result = await SpeechInput.transcribeFile({
      path: stopped?.path ?? '',
      language: speechLocaleFor(language),
    })
    return { text: String(result?.text ?? ''), seconds: stopped?.seconds ?? 0 }
  } finally {
    partialHandler = null
  }
}
