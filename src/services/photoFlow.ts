import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { recognizeText, scriptForLanguage } from './ocrService'
import { translateText } from './translationService'
import { saveCard, type TravelCard } from './cardStore'

/**
 * 拍照翻譯流程編排：
 * 拍照/選圖 → 照片存進 app 永久目錄 → 端側 OCR → ML Kit 翻譯（+OpenCC）→ 存成旅遊卡片
 * 任一步失敗都不會留下半成品卡片。
 */

export type CaptureResult =
  | { status: 'cancelled' }
  | { status: 'saved'; card: TravelCard }
  | { status: 'no-text' }
  | { status: 'error'; message: string }

export async function captureAndTranslate(opts: {
  sourceLang: string
  targetLang: string
}): Promise<CaptureResult> {
  let photo
  try {
    photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt, // 拍照 / 相簿 二選一
      quality: 80,
      width: 1600, // 縮圖：OCR 夠用且省空間
    })
  } catch {
    return { status: 'cancelled' } // 使用者關掉相機/選單
  }

  if (!photo.path) {
    return { status: 'error', message: '無法取得照片' }
  }

  // 照片複製進 app 永久目錄（tmp 會被系統清掉）
  const fileName = `photos/${Date.now()}.jpg`
  let savedUri: string
  try {
    const copied = await Filesystem.copy({
      from: photo.path,
      to: fileName,
      directory: Directory.Data,
    })
    savedUri = copied.uri
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : '照片存檔失敗',
    }
  }

  // OCR（模型綁 APK，離線）
  let ocrText: string
  try {
    ocrText = await recognizeText(savedUri, scriptForLanguage(opts.sourceLang))
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : '文字辨識失敗',
    }
  }
  if (!ocrText) {
    return { status: 'no-text' }
  }

  // 翻譯（ML Kit + OpenCC，離線）
  let translated: string
  try {
    translated = await translateText(ocrText, opts.sourceLang, opts.targetLang)
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : '翻譯失敗（語言包未下載？）',
    }
  }

  const card = saveCard({
    photoPath: savedUri,
    ocrText,
    translatedText: translated,
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
  })
  return { status: 'saved', card }
}
