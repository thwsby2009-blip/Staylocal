import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureModelsReady,
  getDownloadedLanguages,
  downloadLanguage,
  removeLanguage,
} from './modelManager'

vi.mock('@capacitor-mlkit/translation', () => ({
  Translation: {
    downloadModel: vi.fn(),
    getDownloadedModels: vi.fn(),
    deleteDownloadedModel: vi.fn(),
  },
  Language: {
    Chinese: 'zh',
    English: 'en',
    Japanese: 'ja',
  },
}))

import { Translation } from '@capacitor-mlkit/translation'

const mockDownload = Translation.downloadModel as ReturnType<typeof vi.fn>
const mockGetDownloaded = Translation.getDownloadedModels as ReturnType<
  typeof vi.fn
>

describe('ensureModelsReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('兩個模型都已下載 → ready，不觸發下載', async () => {
    mockGetDownloaded.mockResolvedValueOnce({ languages: ['en', 'zh'] })
    const result = await ensureModelsReady('en', 'zh')
    expect(result).toEqual({ status: 'ready', downloaded: ['en', 'zh'] })
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('缺 zh → 下載 zh 後回 downloaded（表示有新下載），並呼叫 downloadModel', async () => {
    mockGetDownloaded.mockResolvedValueOnce({ languages: ['en'] })
    mockDownload.mockResolvedValueOnce(undefined)
    const result = await ensureModelsReady('en', 'zh')
    expect(result.status).toBe('downloaded')
    expect(mockDownload).toHaveBeenCalledWith({ language: 'zh' })
  })

  it('下載拋錯 → 錯誤向上傳播（UI 層顯示給使用者）', async () => {
    mockGetDownloaded.mockResolvedValueOnce({ languages: [] })
    mockDownload.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(ensureModelsReady('en', 'zh')).rejects.toThrow(
      'network unavailable',
    )
  })

  it('onProgress 回呼在下載時被呼叫', async () => {
    mockGetDownloaded.mockResolvedValueOnce({ languages: [] })
    mockDownload.mockImplementationOnce(async () => {})
    const onProgress = vi.fn()
    await ensureModelsReady('en', 'zh', { onProgress })
    expect(onProgress).toHaveBeenCalledWith({ language: 'zh' })
  })
})

describe('語言包管理（getDownloadedLanguages / downloadLanguage / removeLanguage）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getDownloadedLanguages 回已下載清單', async () => {
    mockGetDownloaded.mockResolvedValueOnce({ languages: ['en', 'zh'] })
    expect(await getDownloadedLanguages()).toEqual(['en', 'zh'])
  })

  it('getDownloadedLanguages 壞資料（無 languages 欄位）→ 回空陣列', async () => {
    mockGetDownloaded.mockResolvedValueOnce({} as never)
    expect(await getDownloadedLanguages()).toEqual([])
  })

  it('downloadLanguage 呼叫插件下載', async () => {
    mockDownload.mockResolvedValueOnce(undefined)
    await downloadLanguage('ja')
    expect(mockDownload).toHaveBeenCalledWith({ language: 'ja' })
  })

  it('downloadLanguage 拋錯向上傳播', async () => {
    mockDownload.mockRejectedValueOnce(new Error('no wifi'))
    await expect(downloadLanguage('ja')).rejects.toThrow('no wifi')
  })

  it('removeLanguage 呼叫插件刪除', async () => {
    const { Translation } = await import('@capacitor-mlkit/translation')
    ;(Translation.deleteDownloadedModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      undefined,
    )
    await removeLanguage('ja')
    expect(Translation.deleteDownloadedModel).toHaveBeenCalledWith({
      language: 'ja',
    })
  })
})
