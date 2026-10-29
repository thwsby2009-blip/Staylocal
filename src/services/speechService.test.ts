import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startRecording,
  stopRecordingAndTranscribe,
  isRecordingNow,
  resetSpeechServiceForTests,
  isSpeechSupported,
  speechLocaleFor,
  checkSpeechAvailability,
  toLangList,
  formatSupportInfo,
  senseVoiceLangFor,
  getAsrModelStatus,
  downloadAsrModel,
  deleteAsrModel,
  clearPreviousDictation,
} from './speechService'

// Mock 自製 Capacitor 插件（原生橋接在單元測試不存在）
// vi.mock 的 factory 會被提升到 const 宣告之前，必須用 vi.hoisted 建立共用 mock
const mockStartRecording = vi.hoisted(() => vi.fn())
const mockStopRecording = vi.hoisted(() => vi.fn())
const mockTranscribeFile = vi.hoisted(() => vi.fn())
const mockCheckAvailability = vi.hoisted(() => vi.fn())
const mockCheckSupport = vi.hoisted(() => vi.fn())
const mockDownloadOnDeviceModel = vi.hoisted(() => vi.fn())
const mockAddListener = vi.hoisted(() => vi.fn())
const mockAsrModelStatus = vi.hoisted(() => vi.fn())
const mockDownloadAsrModel = vi.hoisted(() => vi.fn())
const mockDeleteAsrModel = vi.hoisted(() => vi.fn())
const mockTranscribeWithSenseVoice = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    checkAvailability: mockCheckAvailability,
    checkSupport: mockCheckSupport,
    downloadOnDeviceModel: mockDownloadOnDeviceModel,
    startRecording: mockStartRecording,
    stopRecording: mockStopRecording,
    transcribeFile: mockTranscribeFile,
    asrModelStatus: mockAsrModelStatus,
    downloadAsrModel: mockDownloadAsrModel,
    deleteAsrModel: mockDeleteAsrModel,
    transcribeWithSenseVoice: mockTranscribeWithSenseVoice,
    addListener: mockAddListener,
    removeAllListeners: vi.fn(),
  }),
}))

// 攔截 partial 事件（轉寫中的即時逐字稿）
let partialHandler: ((data: { text: string }) => void) | null = null

function emitPartial(text: string) {
  partialHandler?.({ text })
}

describe('speechService（批次：先錄音、停止後轉逐字稿）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSpeechServiceForTests()
    partialHandler = null
    mockAddListener.mockImplementation(async (evt, fn) => {
      if (evt === 'partialTranscript') partialHandler = fn
      return { remove: vi.fn() }
    })
    mockCheckAvailability.mockResolvedValue({ available: true })
    mockStartRecording.mockResolvedValue({ started: true, path: '/tmp/a.wav' })
    mockStopRecording.mockResolvedValue({
      path: '/tmp/a.wav',
      bytes: 32000 * 2,
      seconds: 2,
    })
    mockTranscribeFile.mockResolvedValue({ text: 'hello world' })
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
  })

  it('startRecording 只呼叫原生錄音，不做辨識', async () => {
    await startRecording()
    expect(mockStartRecording).toHaveBeenCalledTimes(1)
    expect(mockTranscribeFile).not.toHaveBeenCalled()
    expect(isRecordingNow()).toBe(true)
  })

  it('停止 → 轉逐字稿：依序呼叫 stopRecording + transcribeFile，回傳文字與秒數', async () => {
    await startRecording()
    const res = await stopRecordingAndTranscribe('en')
    expect(mockStopRecording).toHaveBeenCalledTimes(1)
    expect(mockTranscribeFile).toHaveBeenCalledWith({
      path: '/tmp/a.wav',
      language: 'en-US',
    })
    expect(res).toEqual({ text: 'hello world', seconds: 2, engine: 'system' })
    expect(isRecordingNow()).toBe(false)
  })

  it('轉寫中的 partial 事件會即時回報文字', async () => {
    const seen: string[] = []
    await startRecording((t) => seen.push(t))
    emitPartial('hel')
    emitPartial('hello')
    expect(seen).toEqual(['hel', 'hello'])
  })

  it('錄音中重複 startRecording 要丟錯', async () => {
    await startRecording()
    await expect(startRecording()).rejects.toThrow('已在錄音中')
  })

  it('沒有進行中的錄音就停止要丟錯', async () => {
    await expect(stopRecordingAndTranscribe('en')).rejects.toThrow(
      '沒有進行中的錄音',
    )
  })

  it('錄音啟動失敗：丟出原生訊息且不進錄音狀態', async () => {
    mockStartRecording.mockRejectedValueOnce(new Error('音訊裝置初始化失敗'))
    await expect(startRecording()).rejects.toThrow('音訊裝置初始化失敗')
    expect(isRecordingNow()).toBe(false)
  })

  it('裝置無語音服務時直接丟錯（不呼叫原生錄音）', async () => {
    mockCheckAvailability.mockResolvedValueOnce({ available: false })
    await expect(startRecording()).rejects.toThrow(
      '此裝置沒有可用的語音辨識服務',
    )
    expect(mockStartRecording).not.toHaveBeenCalled()
  })

  it('轉寫失敗：錯誤往上拋（帶原生訊息）', async () => {
    mockTranscribeFile.mockRejectedValueOnce(new Error('轉逐字稿逾時'))
    await startRecording()
    await expect(stopRecordingAndTranscribe('en')).rejects.toThrow(
      '轉逐字稿逾時',
    )
    expect(isRecordingNow()).toBe(false)
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

  it('clearPreviousDictation：未動過才清回聽寫前內容，改過則保留', () => {
    // 上一次聽寫前是空的、結果是「你好世界」→ 這次輸入框還是它（沒動）→ 清空
    expect(
      clearPreviousDictation('你好世界', { expected: '你好世界', base: '' }),
    ).toBe('')
    // 上次聽寫前有手打內容 → 清掉逐字稿後還原成手打內容
    expect(
      clearPreviousDictation('要翻譯的字\n你好世界', {
        expected: '要翻譯的字\n你好世界',
        base: '要翻譯的字',
      }),
    ).toBe('要翻譯的字')
    // 使用者改過（與上次結果不同）→ 原樣保留，不覆寫人工編輯
    expect(
      clearPreviousDictation('要翻譯的字\n你好世界（我改過）', {
        expected: '要翻譯的字\n你好世界',
        base: '要翻譯的字',
      }),
    ).toBe('要翻譯的字\n你好世界（我改過）')
    // 沒有快照（第一次錄音）→ 原樣
    expect(clearPreviousDictation('打字內容', null)).toBe('打字內容')
  })

  it('senseVoiceLangFor：支援的語言回模型語言碼，其餘 null', () => {
    expect(senseVoiceLangFor('zh')).toBe('zh')
    expect(senseVoiceLangFor('en')).toBe('en')
    expect(senseVoiceLangFor('yue')).toBe('yue')
    expect(senseVoiceLangFor('fr')).toBeNull()
  })

  it('高準度模型已安裝：優先走 SenseVoice（回 engine=sensevoice）', async () => {
    mockAsrModelStatus.mockResolvedValue({ installed: true, modelBytes: 239233841, sizeMb: 228, dir: '/d' })
    mockTranscribeWithSenseVoice.mockResolvedValue({ text: '你好世界' })
    await startRecording()
    const res = await stopRecordingAndTranscribe('zh', { preferSenseVoice: true })
    expect(mockTranscribeWithSenseVoice).toHaveBeenCalledWith({
      path: '/tmp/a.wav',
      language: 'zh',
    })
    expect(mockTranscribeFile).not.toHaveBeenCalled()
    expect(res).toEqual({ text: '你好世界', seconds: 2, engine: 'sensevoice' })
  })

  it('高準度模型推論失敗：退回系統引擎（不讓使用者卡住）', async () => {
    mockAsrModelStatus.mockResolvedValue({ installed: true, modelBytes: 1, sizeMb: 1, dir: '/d' })
    mockTranscribeWithSenseVoice.mockRejectedValueOnce(new Error('模型載入失敗'))
    await startRecording()
    const res = await stopRecordingAndTranscribe('zh', { preferSenseVoice: true })
    expect(mockTranscribeFile).toHaveBeenCalledWith({
      path: '/tmp/a.wav',
      language: 'cmn-Hant-TW',
    })
    expect(res.engine).toBe('system')
  })

  it('未安裝模型或未指定偏好：仍走系統引擎', async () => {
    mockAsrModelStatus.mockResolvedValue({ installed: false, modelBytes: 0, sizeMb: 0, dir: '/d' })
    await startRecording()
    const res = await stopRecordingAndTranscribe('zh', { preferSenseVoice: true })
    expect(mockTranscribeWithSenseVoice).not.toHaveBeenCalled()
    expect(res.engine).toBe('system')
  })

  it('getAsrModelStatus：正規化原生回傳；原生丟錯回 null', async () => {
    mockAsrModelStatus.mockResolvedValueOnce({ installed: true, modelBytes: '123', sizeMb: '0', dir: '/d' })
    expect(await getAsrModelStatus()).toEqual({
      installed: true,
      modelBytes: 123,
      sizeMb: 0,
      dir: '/d',
    })
    mockAsrModelStatus.mockRejectedValueOnce(new Error('not implemented'))
    expect(await getAsrModelStatus()).toBeNull()
  })

  it('downloadAsrModel：轉發下載進度事件、回傳大小', async () => {
    let progressHandler: ((d: Record<string, unknown>) => void) | null = null
    mockAddListener.mockImplementation(async (evt, fn) => {
      if (evt === 'partialTranscript') partialHandler = fn
      if (evt === 'asrDownloadProgress') progressHandler = fn
      return { remove: vi.fn() }
    })
    mockDownloadAsrModel.mockImplementation(async () => {
      progressHandler?.({ file: 'model.int8.onnx', received: 50, total: 100, percent: 50 })
      return { installed: true, sizeMb: 228 }
    })
    const seen: number[] = []
    const mb = await downloadAsrModel((p) => seen.push(p.percent))
    expect(seen).toEqual([50])
    expect(mb).toBe(228)
  })

  it('deleteAsrModel：原生丟錯回 false', async () => {
    mockDeleteAsrModel.mockResolvedValueOnce({ deleted: true })
    expect(await deleteAsrModel()).toBe(true)
    mockDeleteAsrModel.mockRejectedValueOnce(new Error('boom'))
    expect(await deleteAsrModel()).toBe(false)
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
