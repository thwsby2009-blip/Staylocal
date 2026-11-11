import { describe, it, expect, vi } from 'vitest'
import {
  liveEngineFor,
  isSenseVoiceLanguage,
} from './speechService'

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
