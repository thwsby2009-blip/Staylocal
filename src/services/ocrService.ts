import { TextRecognition, Script } from '@capacitor-mlkit/text-recognition'

/**
 * 端側 OCR：ML Kit Text Recognition v2。
 * 模型綁進 APK（各 script 約幾 MB），完全離線、免下載。
 */

/** 語言代碼 → OCR script。無專屬模型的語言一律落 Latin。 */
export function scriptForLanguage(lang: string): Script {
  if (lang === 'zh') return Script.Chinese
  if (lang === 'ja') return Script.Japanese
  if (lang === 'ko') return Script.Korean
  return Script.Latin
}

export async function recognizeText(
  imagePath: string,
  script: Script | string,
): Promise<string> {
  const result = await TextRecognition.processImage({
    path: imagePath,
    script: script as Script,
  })
  return result.text.trim()
}
