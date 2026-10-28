import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startDictation,
  stopDictation,
  isDictating,
  resetSpeechServiceForTests,
  isSpeechSupported,
  speechLocaleFor,
  checkSpeechAvailability,
} from './speechService'

// Mock 自製 Capacitor 插件（原生橋接在單元測試不存在）
// vi.mock 的 factory 會被提升到 const 宣告之前，必須用 vi.hoisted 建立共用 mock
const mockStart = vi.hoisted(() => vi.fn())
const mockStop = vi.hoisted(() => vi.fn())
const mockCheckAvailability = vi.hoisted(() => vi.fn())
const mockAddListener = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    checkAvailability: mockCheckAvailability,
    start: mockStart,
    stop: mockStop,
    addListener: mockAddListener,
    removeAllListeners: vi.fn(),
  }),
}))

// 攔截 partial/final 事件（單元測試直接呼叫 handler 模擬原生回呼）
let partialHandler: ((data: { text: string }) => void) | null = null
let finalHandler: ((data: unknown) => void) | null = null

function emitPartial(text: string) {
  partialHandler?.({ text })
}

function emitFinal(data: {
  text: string
  reason: string
  message?: string
}) {
  finalHandler?.(data)
}

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

  it('start→partial→final：transcript 與事件流正確', async () => {
    const partials: string[] = []
    let final: { transcript: string; reason: string } | null = null

    await startDictation({
      language: 'en',
      onPartial: (t) => partials.push(t),
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
    expect(final).toEqual({ transcript: 'hello world', reason: 'engine-end' })
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
    mockStart.mockRejectedValueOnce(new Error('此裝置沒有可用的語音辨識服務'))
    await expect(
      startDictation({
        language: 'en',
        onPartial: () => {},
        onFinal: () => {},
      }),
    ).rejects.toThrow('此裝置沒有可用的語音辨識服務')
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

  it('stop：請求原生停止，結果由 manual-stop final 收尾', async () => {
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

    // 手動停止後，原生送 manual-stop final
    emitFinal({ text: 'some text', reason: 'manual-stop' })
    expect(final).toEqual({ transcript: 'some text', reason: 'manual-stop' })
    expect(isDictating()).toBe(false)
  })

  it('checkSpeechAvailability：快取生效，只打一次原生', async () => {
    expect(await checkSpeechAvailability()).toBe(true)
    expect(await checkSpeechAvailability()).toBe(true)
    expect(mockCheckAvailability).toHaveBeenCalledTimes(1)
  })
})
