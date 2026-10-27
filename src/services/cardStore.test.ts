import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listCards, saveCard, deleteCard, type TravelCard } from './cardStore'

// 簡單 localStorage mock（不引入 jsdom）
const storage = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
}
vi.stubGlobal('localStorage', localStorageMock)

describe('cardStore', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('空儲存 → listCards 回空陣列', () => {
    expect(listCards()).toEqual([])
  })

  it('saveCard 會補 id 與 createdAt，listCards 取回', () => {
    const card = saveCard({
      photoPath: 'photos/a.jpg',
      ocrText: 'MENU',
      translatedText: '菜單',
      sourceLang: 'en',
      targetLang: 'zh',
    } as Omit<TravelCard, 'id' | 'createdAt'>)
    expect(card.id).toBeTruthy()
    expect(card.createdAt).toBeGreaterThan(0)
    expect(listCards()).toHaveLength(1)
  })

  it('listCards 依時間新→舊排序', () => {
    const a = saveCard(fixCard('a'))
    const b = saveCard(fixCard('b'))
    const list = listCards()
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it('deleteCard 後消失', () => {
    const card = saveCard(fixCard('x'))
    deleteCard(card.id)
    expect(listCards()).toEqual([])
  })

  it('storage 內容損壞（非 JSON）→ 回空陣列不拋錯', () => {
    storage.set('ot_cards', '{{{corrupt}}')
    expect(listCards()).toEqual([])
  })

  it('storage 內容是 JSON 但非陣列 → 回空陣列', () => {
    storage.set('ot_cards', '{"evil":true}')
    expect(listCards()).toEqual([])
  })
})

function fixCard(tag: string): Omit<TravelCard, 'id' | 'createdAt'> {
  return {
    photoPath: `photos/${tag}.jpg`,
    ocrText: tag,
    translatedText: tag,
    sourceLang: 'en',
    targetLang: 'zh',
  }
}
