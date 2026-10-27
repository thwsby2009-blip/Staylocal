/**
 * 旅遊卡片儲存：照片路徑 + OCR 原文 + 譯文。
 * metadata 存 localStorage（輕量、同步、夠用）；照片檔在本機檔案系統（Filesystem）。
 * 防禦：儲存內容損壞時回空集合，不讓壞資料炸掉整個 app。
 */

export interface TravelCard {
  id: string
  photoPath: string
  /** WebView <img> 顯示用（convertFileSrc 轉換後的路徑） */
  photoWebPath?: string
  ocrText: string
  translatedText: string
  sourceLang: string
  targetLang: string
  createdAt: number
}

const KEY = 'ot_cards'

function readAll(): TravelCard[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TravelCard[]
  } catch {
    return []
  }
}

function writeAll(cards: TravelCard[]): void {
  localStorage.setItem(KEY, JSON.stringify(cards))
}

export function listCards(): TravelCard[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt)
}

export function saveCard(
  card: Omit<TravelCard, 'id' | 'createdAt'>,
): TravelCard {
  const full: TravelCard = {
    ...card,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  }
  writeAll([full, ...readAll()])
  return full
}

export function deleteCard(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
}
