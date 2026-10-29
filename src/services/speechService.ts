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
  /** 高準度離線模型（SenseVoice）狀態 */
  asrModelStatus(): Promise<{
    installed: boolean
    modelBytes: number
    sizeMb: number
    dir: string
  }>
  /** 下載高準度離線模型（背景執行，進度走 asrDownloadProgress） */
  downloadAsrModel(options: {
    modelUrl?: string
    tokensUrl?: string
  }): Promise<{ installed: boolean; sizeMb: number }>
  /** 刪除高準度離線模型（釋放空間） */
  deleteAsrModel(): Promise<{ deleted: boolean }>
  /** 用 SenseVoice 轉寫音檔（離線、含標點） */
  transcribeWithSenseVoice(options: {
    path: string
    language: string
  }): Promise<{ text: string }>
  addListener(
    eventName: 'partialTranscript' | 'asrDownloadProgress',
    listenerFunc: (data: Record<string, unknown>) => void,
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
  downloadHandler = null
  downloadListenerReady = false
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
 * 已安裝高準度模型（SenseVoice）且該語言支援時優先使用（品質較好、含標點）；
 * 未安裝或推論失敗則退回系統端側引擎。
 * 回傳 { text, seconds, engine }；兩條路都失敗才丟錯。
 */
export async function stopRecordingAndTranscribe(
  language: string,
  options?: { preferSenseVoice?: boolean },
): Promise<{ text: string; seconds: number; engine: 'sensevoice' | 'system' }> {
  if (!recording) throw new Error('沒有進行中的錄音')
  recording = false
  const stopped = await SpeechInput.stopRecording()
  const path = stopped?.path ?? ''
  const seconds = stopped?.seconds ?? 0
  try {
    const svLang = senseVoiceLangFor(language)
    if (options?.preferSenseVoice && svLang) {
      const status = await getAsrModelStatus()
      if (status?.installed) {
        try {
          const r = await SpeechInput.transcribeWithSenseVoice({
            path,
            language: svLang,
          })
          const text = String(r?.text ?? '')
          if (text.trim()) return { text, seconds, engine: 'sensevoice' }
        } catch {
          // 高準度模型出錯就退回系統引擎，不讓使用者卡住
        }
      }
    }
    const result = await SpeechInput.transcribeFile({
      path,
      language: speechLocaleFor(language),
    })
    return {
      text: String(result?.text ?? ''),
      seconds,
      engine: 'system' as const,
    }
  } finally {
    partialHandler = null
  }
}

/** 上一次聽寫的快照（用來在下次錄音前清掉舊逐字稿） */
export interface DictationSnapshot {
  /** 上一次聽寫完成後，輸入框「應該」長什麼樣 */
  expected: string
  /** 上一次聽寫前的內容（清掉時還原成它） */
  base: string
}

/**
 * 新的一次錄音開始前，清掉上一次的逐字稿。
 * 只有當輸入框內容與上一次聽寫後的結果「完全相同」（＝使用者沒動過）才清回
 * 聽寫前的內容；只要使用者改過就原樣保留，不覆寫人工編輯。
 * （用完全比對而非包含比對：後者會把「使用者改過的內容」誤切一半。）
 */
export function clearPreviousDictation(
  input: string,
  snapshot: DictationSnapshot | null,
): string {
  if (!snapshot) return input
  return input === snapshot.expected ? snapshot.base : input
}

// ===== 高準度離線語音模型（SenseVoice / sherpa-onnx，選用加強）=====
// 系統端側引擎品質有限且無標點；此模型（約 240MB，首次使用時下載）中文品質明顯較好、
// 內建標點。語言碼用模型自己的（zh/yue/en/ja/ko），與系統的 BCP-47 不同。

export interface AsrModelStatus {
  installed: boolean
  modelBytes: number
  sizeMb: number
  dir: string
}

export interface AsrDownloadProgress {
  file: string
  received: number
  total: number
  percent: number
}

const SENSEVOICE_LOCALES: Record<string, string> = {
  zh: 'zh',
  yue: 'yue',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
}

/** 該語言是否支援高準度模型（不支援回 null） */
export function senseVoiceLangFor(langCode: string): string | null {
  return SENSEVOICE_LOCALES[langCode] ?? null
}

let downloadHandler: ((p: AsrDownloadProgress) => void) | null = null
let downloadListenerReady = false

async function ensureDownloadListener(): Promise<void> {
  if (downloadListenerReady) return
  await SpeechInput.addListener('asrDownloadProgress', (data) => {
    downloadHandler?.({
      file: String(data?.file ?? ''),
      received: Number(data?.received ?? 0),
      total: Number(data?.total ?? 0),
      percent: Number(data?.percent ?? -1),
    })
  })
  downloadListenerReady = true
}

/** 查詢高準度模型是否已安裝（瀏覽器預覽時回 null） */
export async function getAsrModelStatus(): Promise<AsrModelStatus | null> {
  try {
    const r = await SpeechInput.asrModelStatus()
    return {
      installed: !!r?.installed,
      modelBytes: Number(r?.modelBytes ?? 0),
      sizeMb: Number(r?.sizeMb ?? 0),
      dir: String(r?.dir ?? ''),
    }
  } catch {
    return null
  }
}

/** 下載高準度模型（需網路，約 240MB）；回傳實際大小 MB */
export async function downloadAsrModel(
  onProgress?: (p: AsrDownloadProgress) => void,
): Promise<number> {
  downloadHandler = onProgress ?? null
  await ensureDownloadListener()
  try {
    const r = await SpeechInput.downloadAsrModel({})
    return Number(r?.sizeMb ?? 0)
  } finally {
    downloadHandler = null
  }
}

/** 刪除高準度模型 */
export async function deleteAsrModel(): Promise<boolean> {
  try {
    const r = await SpeechInput.deleteAsrModel()
    return !!r?.deleted
  } catch {
    return false
  }
}
