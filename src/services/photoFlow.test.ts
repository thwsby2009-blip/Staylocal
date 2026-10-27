import { describe, it, expect, vi, beforeEach } from 'vitest'
import { captureAndTranslate } from './photoFlow'

vi.mock('@capacitor/core', () => ({
  Capacitor: { convertFileSrc: (p: string) => `web:${p}` },
}))
vi.mock('@capacitor/camera', () => ({
  Camera: { getPhoto: vi.fn() },
  CameraResultType: { Uri: 'uri' },
  CameraSource: { Prompt: 'PROMPT' },
}))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { copy: vi.fn(), mkdir: vi.fn() },
  Directory: { Data: 'DATA' },
}))
vi.mock('./ocrService', () => ({ recognizeText: vi.fn(), scriptForLanguage: vi.fn(() => 'LATIN') }))
vi.mock('./translationService', () => ({ translateText: vi.fn() }))
vi.mock('./cardStore', () => ({ saveCard: vi.fn() }))

import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Filesystem } from '@capacitor/filesystem'
import { recognizeText } from './ocrService'
import { translateText } from './translationService'
import { saveCard } from './cardStore'

const mockGetPhoto = Camera.getPhoto as ReturnType<typeof vi.fn>
const mockCopy = Filesystem.copy as ReturnType<typeof vi.fn>
const mockMkdir = Filesystem.mkdir as ReturnType<typeof vi.fn>
const mockOcr = recognizeText as ReturnType<typeof vi.fn>
const mockTranslate = translateText as ReturnType<typeof vi.fn>
const mockSave = saveCard as ReturnType<typeof vi.fn>

const baseOpts = { sourceLang: 'en', targetLang: 'zh' }

describe('captureAndTranslate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPhoto.mockResolvedValue({ path: 'file:///tmp/p1.jpg' })
    mockCopy.mockResolvedValue({ uri: 'file:///data/photos/p1.jpg' })
    mockOcr.mockResolvedValue('CLOSED')
    mockTranslate.mockResolvedValue('已打烊')
    mockSave.mockImplementation((c) => ({ id: 'card1', createdAt: 1, ...c }))
  })

  it('使用者取消拍照 → 回 cancelled，不碰後續流程', async () => {
    mockGetPhoto.mockRejectedValueOnce(new Error('User cancelled'))
    const result = await captureAndTranslate(baseOpts)
    expect(result.status).toBe('cancelled')
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('成功流程：拍照→存檔→OCR→翻譯→存卡片（含 webview 顯示路徑）', async () => {
    const result = await captureAndTranslate(baseOpts)
    expect(result.status).toBe('saved')
    expect(mockCopy).toHaveBeenCalled()
    expect(mockOcr).toHaveBeenCalledWith('file:///data/photos/p1.jpg', 'LATIN')
    expect(mockTranslate).toHaveBeenCalledWith('CLOSED', 'en', 'zh')
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        photoPath: 'file:///data/photos/p1.jpg',
        photoWebPath: 'web:file:///data/photos/p1.jpg',
        ocrText: 'CLOSED',
        translatedText: '已打烊',
      }),
    )
  })

  it('OCR 沒辨識到文字 → 回 no-text，不存卡片', async () => {
    mockOcr.mockResolvedValueOnce('')
    const result = await captureAndTranslate(baseOpts)
    expect(result.status).toBe('no-text')
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('翻譯失敗（如語言包未下載）→ 回 error，不存卡片，錯誤訊息帶出', async () => {
    mockTranslate.mockRejectedValueOnce(new Error('model not downloaded'))
    const result = await captureAndTranslate(baseOpts)
    if (result.status !== 'error') {
      throw new Error(`expected error, got: ${result.status}`)
    }
    expect(result.message).toContain('model not downloaded')
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('拍照選項：Prompt 來源（拍照/相簿二選一）、Uri 結果、限寬 1600', async () => {
    await captureAndTranslate(baseOpts)
    expect(mockGetPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        resultType: CameraResultType.Uri,
        source: CameraSource.Prompt,
        width: 1600,
      }),
    )
  })

  it('photos 目錄不存在（mkdir 拋 exists 錯誤）→ 流程照常繼續', async () => {
    mockMkdir.mockRejectedValueOnce(new Error('directory exists'))
    const result = await captureAndTranslate(baseOpts)
    expect(result.status).toBe('saved')
  })
})
