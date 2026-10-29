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

/** 測試用：重置可用性快取與監聽狀態 */
export function resetSpeechServiceForTests(): void {
  availabilityCache = null
  session = null
  listenersRegistered = false
  listening = false
  restartTimer = null
}

type PartialHandler = (text: string) => void
type SegmentHandler = (segment: string) => void
type FinalHandler = (result: SpeechSessionResult) => void

interface DictationSession {
  language: string
  segments: string[]
  stopped: boolean
  onPartial: PartialHandler
  onSegment: SegmentHandler
  onFinal: FinalHandler
}

let session: DictationSession | null = null
let listenersRegistered = false
let listening = false
let restartTimer: ReturnType<typeof setTimeout> | null = null

async function ensureListeners(): Promise<void> {
  if (listenersRegistered) return
  await SpeechInput.addListener('partialTranscript', (data) => {
    session?.onPartial(String(data?.text ?? ''))
  })
  await SpeechInput.addListener('finalTranscript', (data) => {
    const s = session
    if (!s) {
      listening = false
      return
    }
    const text = String(data?.text ?? '')
    if (text) {
      s.segments.push(text)
      s.onSegment(text)
    }
    if (data?.reason === 'error') {
      session = null
      listening = false
      s.onFinal({
        transcript: s.segments.join('\n'),
        reason: 'error',
        message: data?.message,
      })
      return
    }
    if (!s.stopped) {
      // 連續聽寫：使用者未按停止 → 安靜地接續下一段
      listening = true
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (session === s && !s.stopped) {
          SpeechInput.start({ language: speechLocaleFor(s.language) }).catch(() => {
            // 單次重啟失敗不中斷整場
          })
        }
      }, 200)
      return
    }
    // 使用者已按停止 → 收尾
    session = null
    listening = false
    s.onFinal({
      transcript: s.segments.join('\n'),
      reason: data?.reason ?? 'manual-stop',
    })
  })
  listenersRegistered = true
}

export function isDictating(): boolean {
  return listening
}

/**
 * 開始「連續聽寫」：講話出字、停頓自動接續，直到 stopDictation()。
 * - onPartial：當前段的即時文字
 * - onSegment：每完成一段呼叫一次（App 端累加顯示）
 * - onFinal：只在使用者停止或發生錯誤時呼叫一次
 */
export async function startDictation(opts: {
  language: string
  onPartial: PartialHandler
  onSegment?: SegmentHandler
  onFinal: FinalHandler
}): Promise<void> {
  if (session) {
    throw new Error('已在錄音中')
  }
  const available = await checkSpeechAvailability()
  if (!available) {
    throw new Error('此裝置沒有可用的語音辨識服務')
  }
  await ensureListeners()
  const s: DictationSession = {
    language: opts.language,
    segments: [],
    stopped: false,
    onPartial: opts.onPartial,
    onSegment: opts.onSegment ?? (() => {}),
    onFinal: opts.onFinal,
  }
  session = s
  listening = true
  try {
    await SpeechInput.start({ language: speechLocaleFor(opts.language) })
  } catch (e) {
    session = null
    listening = false
    throw new Error(e instanceof Error ? e.message : '語音辨識啟動失敗')
  }
}

/** 停止連續聽寫：結束當前段後由 onFinal 收尾 */
export async function stopDictation(): Promise<void> {
  const s = session
  if (!s) return
  s.stopped = true
  if (restartTimer) {
    // 正好在兩段之間的重啟空檔：直接收尾，不必等引擎
    clearTimeout(restartTimer)
    restartTimer = null
    session = null
    listening = false
    s.onFinal({ transcript: s.segments.join('\n'), reason: 'manual-stop' })
    return
  }
  await SpeechInput.stop()
}
