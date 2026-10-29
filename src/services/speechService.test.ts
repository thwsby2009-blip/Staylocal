import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startDictation,
  stopDictation,
  isDictating,
  resetSpeechServiceForTests,
  isSpeechSupported,
  speechLocaleFor,
  checkSpeechAvailability,
  toLangList,
  formatSupportInfo,
} from './speechService'

// Mock 自製 Capacitor 插件（原生橋接在單元測試不存在）
// vi.mock 的 factory 會被提升到 const 宣告之前，必須用 vi.hoisted 建立共用 mock
const mockStart = vi.hoisted(() => vi.fn())
const mockStop = vi.hoisted(() => vi.fn())
const mockCheckAvailability = vi.hoisted(() => vi.fn())
const mockCheckSupport = vi.hoisted(() => vi.fn())
const mockDownloadOnDeviceModel = vi.hoisted(() => vi.fn())
const mockAddListener = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    checkAvailability: mockCheckAvailability,
    checkSupport: mockCheckSupport,
    downloadOnDeviceModel: mockDownloadOnDeviceModel,
    start: mockStart,
    stop: mockStop,
    addListener: mockAddListener,
    removeAllListeners: vi.fn(),
  }),
}))

// 攔截 partial/final 事件（單元測試直接呼叫 handler 模擬原生回呼）
let partialHandler: ((data: { text: string }) => void) | null = null
let finalHandler:
  | ((data: { text: string; reason: string; message?: string }) => void)
  | null = null

function emitPartial(text: string) {
  partialHandler?.({ text })
}

function emitFinal(data: { text: string; reason: string; message?: string }) {
  finalHandler?.(data)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('speechService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSpeechServiceForTests()
    partialHandler = null
    finalHandler = null
    mockAddListener.mockImplementation(async (_evt, fn) => {
      if (_evt === 'partialTranscript') partialHandler = fn
      if (_evt === 'finalTranscript') finalHandler = fn
      return { remove: vi.fn() }
    })
    mockCheckAvailability.mockResolvedValue({ available: true })
    mockStart.mockResolvedValue({ started: true })
    mockStop.mockResolvedValue(undefined)
  })

  it('locale 對映：ML Kit 短碼轉 BCP-47', () => {
    expect(speechLocaleFor('en')).toBe('en-US')
    expect(speechLocaleFor('zh')).toBe('cmn-Hant-TW')
    expect(speechLocaleFor('ja')).toBe('ja-JP')
    expect(speechLocaleFor('xx')).toBe('en-US')
  })

  it('isSpeechSupported：已映射語言 true，未映射 false', () => {
    expect(isSpeechSupported('en')).toBe(true)
    expect(isSpeechSupported('th')).toBe(true)
    expect(isSpeechSupported('pl')).toBe(false)
    expect(isSpeechSupported('sw')).toBe(false)
  })

  it('連續聽寫：段落完成自動接續，按停止才收尾', async () => {
    const partials: string[] = []
    const segments: string[] = []
    let final: { transcript: string; reason: string } | null = null

    await startDictation({
      language: 'en',
      onPartial: (t) => partials.push(t),
      onSegment: (s) => segments.push(s),
      onFinal: (r) => {
        final = r
      },
    })

    expect(mockStart).toHaveBeenCalledWith({ language: 'en-US' })
    expect(isDictating()).toBe(true)

    emitPartial('hello')
    emitPartial('hello world')
    emitFinal({ text: 'hello world', reason: 'engine-end' })

    expect(partials).toEqual(['hello', 'hello world'])
    expect(segments).toEqual(['hello world'])
    expect(final).toBeNull() // 使用者尚未停止 → 不收尾
    expect(isDictating()).toBe(true)

    // 200ms 後自動接續下一段
    await sleep(260)
    expect(mockStart).toHaveBeenCalledTimes(2)

    // 使用者按停止 → 收尾
    await stopDictation()
    emitFinal({ text: 'second part', reason: 'manual-stop' })
    expect(segments).toEqual(['hello world', 'second part'])
    expect(final).toEqual({
      transcript: 'hello world\nsecond part',
      reason: 'manual-stop',
    })
    expect(isDictating()).toBe(false)
  })

  it('在重啟空檔按停止：不需等引擎，直接收尾', async () => {
    let final: { transcript: string; reason: string } | null = null
    await startDictation({
      language: 'en',
      onPartial: () => {},
      onFinal: (r) => {
        final = r
      },
    })
    emitFinal({ text: 'one', reason: 'engine-end' })
    expect(final).toBeNull()

    // 200ms 的重啟計時器還沒到期就按停止
    await stopDictation()
    expect(final).toEqual({ transcript: 'one', reason: 'manual-stop' })
    expect(isDictating()).toBe(false)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('錯誤事件立即收尾並帶訊息', async () => {
    let final: { transcript: string; reason: string; message?: string } | null =
      null
    await startDictation({
      language: 'en',
      onPartial: () => {},
      onFinal: (r) => {
        final = r
      },
    })
    emitFinal({ text: '', reason: 'error', message: 'boom' })
    expect(final).toEqual({ transcript: '', reason: 'error', message: 'boom' })
    expect(isDictating()).toBe(false)
  })

  it('錄音中重複 start 要丟錯', async () => {
    await startDictation({
      language: 'en',
      onPartial: () => {},
      onFinal: () => {},
    })
    await expect(
      startDictation({
        language: 'en',
        onPartial: () => {},
        onFinal: () => {},
      }),
    ).rejects.toThrow('已在錄音中')
  })

  it('start 失敗要丟出原生訊息且不進 listening', async () => {
    mockStart.mockRejectedValueOnce(new Error('語音辨識啟動失敗：busy'))
    await expect(
      startDictation({
        language: 'en',
        onPartial: () => {},
        onFinal: () => {},
      }),
    ).rejects.toThrow('busy')
    expect(isDictating()).toBe(false)
  })

  it('裝置無語音服務時直接丟錯（不呼叫 start）', async () => {
    mockCheckAvailability.mockResolvedValueOnce({ available: false })
    await expect(
      startDictation({
        language: 'en',
        onPartial: () => {},
        onFinal: () => {},
      }),
    ).rejects.toThrow('此裝置沒有可用的語音辨識服務')
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('stop 在引擎仍聽時：請求原生停止，結果由 manual-stop final 收尾', async () => {
    let final: { transcript: string; reason: string } | null = null
    await startDictation({
      language: 'en',
      onPartial: () => {},
      onFinal: (r) => {
        final = r
      },
    })
    expect(isDictating()).toBe(true)
    await stopDictation()
    expect(mockStop).toHaveBeenCalled()

    emitFinal({ text: 'some text', reason: 'manual-stop' })
    expect(final).toEqual({ transcript: 'some text', reason: 'manual-stop' })
    expect(isDictating()).toBe(false)
  })

  it('checkSpeechAvailability：快取生效，只打一次原生', async () => {
    expect(await checkSpeechAvailability()).toBe(true)
    expect(await checkSpeechAvailability()).toBe(true)
    expect(mockCheckAvailability).toHaveBeenCalledTimes(1)
  })

  it('toLangList：容忍字串化清單（序列化防禦）', () => {
    expect(toLangList(['en-US', 'ja-JP'])).toEqual(['en-US', 'ja-JP'])
    expect(toLangList('[en-US, ja-JP]')).toEqual(['en-US', 'ja-JP'])
    expect(toLangList('[]')).toEqual([])
    expect(toLangList(undefined)).toEqual([])
  })

  it('formatSupportInfo：列出已安裝與可下載', () => {
    const text = formatSupportInfo({
      onDeviceAvailable: true,
      installedOnDeviceLanguages: ['en-US'],
      pendingOnDeviceLanguages: [],
      supportedOnDeviceLanguages: ['cmn-Hant-TW'],
      onlineLanguages: [],
      error: '',
    })
    expect(text).toContain('端側辨識服務=有')
    expect(text).toContain('已安裝=en-US')
    expect(text).toContain('可下載=cmn-Hant-TW')
    expect(text).toContain('待下載=（無）')
  })
})
