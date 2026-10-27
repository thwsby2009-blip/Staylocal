import { describe, it, expect, vi, beforeEach } from 'vitest'
import { translateText, resetConverterCacheForTests } from './translationService'

// Mock Capacitor 插件層（原生橋接在單元測試不存在）
vi.mock('@capacitor-mlkit/translation', () => ({
  Translation: {
    translate: vi.fn(),
  },
  Language: {
    Chinese: 'zh',
    English: 'en',
    Japanese: 'ja',
  },
}))

import { Translation } from '@capacitor-mlkit/translation'

const mockTranslate = Translation.translate as ReturnType<typeof vi.fn>

describe('translateText', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetConverterCacheForTests()
  })

  it('目標為中文時，ML Kit 簡體輸出要經 OpenCC cn→twp 繁化（含詞彙轉換）', async () => {
    mockTranslate.mockResolvedValueOnce({ text: '这个软件很好用' })
    const result = await translateText('hello', 'en', 'zh')
    // s2twp：简→簡、体→體，且 软件→軟體（台灣詞彙）
    expect(result).toBe('這個軟體很好用')
    expect(mockTranslate).toHaveBeenCalledWith({
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    })
  })

  it('目標非中文時，直接回傳 ML Kit 結果（不經 OpenCC）', async () => {
    mockTranslate.mockResolvedValueOnce({ text: 'MLKIT_RAW_OUTPUT' })
    const result = await translateText('hello', 'en', 'ja')
    expect(result).toBe('MLKIT_RAW_OUTPUT')
  })

  it('空字串直接回傳空字串，不呼叫插件', async () => {
    const result = await translateText('', 'en', 'zh')
    expect(result).toBe('')
    expect(mockTranslate).not.toHaveBeenCalled()
  })

  it('插件拋錯時，錯誤向上傳播', async () => {
    mockTranslate.mockRejectedValueOnce(new Error('model not downloaded'))
    await expect(translateText('hello', 'en', 'zh')).rejects.toThrow(
      'model not downloaded',
    )
  })
})
