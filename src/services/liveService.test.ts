import { describe, it, expect, vi } from 'vitest'
import {
  liveEngineFor,
  isSenseVoiceLanguage,
} from './speechService'
import { tidyCjk } from './translationService'

// 只測純函式（語言 → 引擎對應）；原生橋接在單元測試不存在
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}) }))

describe('即時翻譯：語言 → 語音引擎對應', () => {
  it('中／英／日／韓／粵 走 SenseVoice（即使多語模型已安裝也優先）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko', 'yue']) {
      expect(isSenseVoiceLanguage(lang)).toBe(true)
      expect(liveEngineFor(lang, false)).toBe('sensevoice')
      expect(liveEngineFor(lang, true)).toBe('sensevoice')
    }
  })

  it('其他語言（如丹麥文）需要多語模型：未安裝回 null、已安裝走 Whisper', () => {
    expect(isSenseVoiceLanguage('da')).toBe(false)
    expect(liveEngineFor('da', false)).toBeNull()
    expect(liveEngineFor('da', true)).toBe('whisper')
  })
})

describe('CJK 語音輸出清理（tidyCjk）', () => {
  it('移除日文詞間多餘空白與被切開的詞', () => {
    expect(tidyCjk('言葉 は 使わない なぜ なら 普段 使わ な いから')).toBe(
      '言葉は使わないなぜなら普段使わないから',
    )
  })

  it('保留拉丁字母周圍的空白（如 YouTube）', () => {
    expect(tidyCjk('ユーチューブで 見てる people')).toBe('ユーチューブで見てる people')
  })

  it('非 CJK 字串不受影響、空字串安全', () => {
    expect(tidyCjk('Jag heter Lina.')).toBe('Jag heter Lina.')
    expect(tidyCjk('')).toBe('')
  })
})
