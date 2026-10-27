import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptForLanguage, recognizeText } from './ocrService'

vi.mock('@capacitor-mlkit/text-recognition', () => ({
  TextRecognition: {
    processImage: vi.fn(),
  },
  Script: {
    Latin: 'LATIN',
    Chinese: 'CHINESE',
    Japanese: 'JAPANESE',
    Korean: 'KOREAN',
    Devanagari: 'DEVANAGARI',
  },
}))

import { TextRecognition } from '@capacitor-mlkit/text-recognition'

const mockProcess = TextRecognition.processImage as ReturnType<typeof vi.fn>

describe('scriptForLanguage', () => {
  it('zh → CHINESE', () => expect(scriptForLanguage('zh')).toBe('CHINESE'))
  it('ja → JAPANESE', () => expect(scriptForLanguage('ja')).toBe('JAPANESE'))
  it('ko → KOREAN', () => expect(scriptForLanguage('ko')).toBe('KOREAN'))
  it('en → LATIN', () => expect(scriptForLanguage('en')).toBe('LATIN'))
  it('th → LATIN（無專屬模型的語言落到 Latin）', () =>
    expect(scriptForLanguage('th')).toBe('LATIN'))
})

describe('recognizeText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('呼叫插件並回傳去頭尾空白後的文字', async () => {
    mockProcess.mockResolvedValueOnce({ text: '  東京駅  \n ', blocks: [] })
    const result = await recognizeText('/photos/x.jpg', 'JAPANESE')
    expect(result).toBe('東京駅')
    expect(mockProcess).toHaveBeenCalledWith({
      path: '/photos/x.jpg',
      script: 'JAPANESE',
    })
  })

  it('OCR 失敗時錯誤向上傳播', async () => {
    mockProcess.mockRejectedValueOnce(new Error('image unreadable'))
    await expect(recognizeText('/bad.jpg', 'LATIN')).rejects.toThrow(
      'image unreadable',
    )
  })
})
