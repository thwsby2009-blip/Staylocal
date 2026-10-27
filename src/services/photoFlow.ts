import { Capacitor } from '@capacitor/core'
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

/** photos/ 目錄存在性（已存在時忽略錯誤） */
async function ensurePhotosDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: 'photos',
      directory: Directory.Data,
      recursive: true,
    })
  } catch {
    // 已存在或其他非致命錯誤 — copy 時會再驗證
  }
}

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
  } catch (e) {
    // 只有使用者主動關閉相機/選單才靜默；權限被拒、插件異常要讓使用者看到原因
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('cancel')) {
      return { status: 'cancelled' }
    }
    return { status: 'error', message: `相機開啟失敗：${msg}` }
  }

  if (!photo.path) {
    return {
      status: 'error',
      message: `無法取得照片檔案路徑（webPath=${photo.webPath ? '有' : '無'}）`,
    }
  }

  // 照片複製進 app 永久目錄（tmp 會被系統清掉）
  // 注意：相簿選圖在舊版 Android 回傳 content:// URI，copy 可能失敗；
  // 失敗時不中斷流程，退回用原圖直接 OCR（顯示用 webPath）。
  await ensurePhotosDir()
  const fileName = `photos/${Date.now()}.jpg`
  let storedPath = photo.path
  try {
    const copied = await Filesystem.copy({
      from: photo.path,
      to: fileName,
      directory: Directory.Data,
    })
    storedPath = copied.uri
  } catch {
    // copy 失敗仍可繼續：OCR 用原始 path
  }

  // OCR（模型綁 APK，離線）
  let ocrText: string
  try {
    ocrText = await recognizeText(storedPath, scriptForLanguage(opts.sourceLang))
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
    photoPath: storedPath,
    photoWebPath: photo.webPath ?? Capacitor.convertFileSrc(storedPath), // WebView <img> 顯示用
    ocrText,
    translatedText: translated,
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
  })
  return { status: 'saved', card }
}
