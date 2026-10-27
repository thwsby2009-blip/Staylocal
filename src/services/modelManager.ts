import { Translation, Language } from '@capacitor-mlkit/translation'

/**
 * 語言包管理：確保翻譯前來源/目標語言模型已下載。
 *
 * ML Kit 語言包各約 30MB，翻譯時若缺模型會自動下載（會卡很久且無進度資訊），
 * 因此明確管理：先查詢已下載清單，缺的才呼叫 downloadModel。
 */

export interface EnsureResult {
  status: 'ready' | 'downloaded'
  downloaded: string[]
}

export interface EnsureOptions {
  onProgress?: (info: { language: string }) => void
}

export async function ensureModelsReady(
  sourceLanguage: string,
  targetLanguage: string,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  const { onProgress } = options

  const { languages } = await Translation.getDownloadedModels()
  const downloadedSet = new Set<string>(languages)

  const needed = [sourceLanguage, targetLanguage].filter(
    (lang) => !downloadedSet.has(lang),
  )

  for (const language of needed) {
    onProgress?.({ language })
    await Translation.downloadModel({ language: language as Language })
    downloadedSet.add(language)
  }

  return {
    status: needed.length > 0 ? 'downloaded' : 'ready',
    downloaded: [...downloadedSet],
  }
}

/** 刪除語言包（測試「重新下載」流程用，UI 也可暴露） */
export async function deleteModel(language: string): Promise<void> {
  await Translation.deleteDownloadedModel({ language: language as Language })
}

// ---- 語言包管理頁用 ----

/** 已下載的語言清單（插件回傳格式異常時回空陣列） */
export async function getDownloadedLanguages(): Promise<string[]> {
  const result = await Translation.getDownloadedModels()
  return Array.isArray(result?.languages) ? result.languages : []
}

/** 下載單一語言包（各約 30MB，建議 WiFi） */
export async function downloadLanguage(language: string): Promise<void> {
  await Translation.downloadModel({ language: language as Language })
}

/** 刪除單一語言包（釋放空間） */
export async function removeLanguage(language: string): Promise<void> {
  await Translation.deleteDownloadedModel({ language: language as Language })
}
