import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { translateText } from './services/translationService'
import {
  ensureModelsReady,
  getDownloadedLanguages,
  downloadLanguage,
  removeLanguage,
} from './services/modelManager'
import { captureAndTranslate, type CaptureResult } from './services/photoFlow'
import { listCards, deleteCard, type TravelCard } from './services/cardStore'
import { LANGUAGES, languageName } from './languages'

type Tab = 'collection' | 'text' | 'packs'
type Busy = null | 'downloading' | 'translating' | 'processing'

function App() {
  const [tab, setTab] = useState<Tab>('collection')

  // 收藏夾
  const [cards, setCards] = useState<TravelCard[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<Busy>(null)

  // 文字翻譯
  const [source, setSource] = useState('en')
  const [target, setTarget] = useState('zh')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [textError, setTextError] = useState('')

  // 語言包管理
  const [downloadedLangs, setDownloadedLangs] = useState<string[]>([])
  const [packBusy, setPackBusy] = useState<string | null>(null)
  const [packError, setPackError] = useState('')

  const refreshCards = useCallback(() => setCards(listCards()), [])

  const refreshPacks = useCallback(async () => {
    try {
      setDownloadedLangs(await getDownloadedLanguages())
    } catch {
      // 原生層未就緒（如純瀏覽器預覽）時靜默
    }
  }, [])

  useEffect(() => {
    refreshCards()
  }, [refreshCards])

  useEffect(() => {
    if (tab === 'packs') void refreshPacks()
  }, [tab, refreshPacks])

  async function handleDownload(lang: string) {
    setPackError('')
    setPackBusy(lang)
    try {
      await downloadLanguage(lang)
      await refreshPacks()
    } catch (e) {
      setPackError(
        `${languageName(lang)}下載失敗：${e instanceof Error ? e.message : '請確認網路連線'}`,
      )
    } finally {
      setPackBusy(null)
    }
  }

  async function handleRemove(lang: string) {
    setPackError('')
    setPackBusy(lang)
    try {
      await removeLanguage(lang)
      await refreshPacks()
    } catch (e) {
      setPackError(
        `${languageName(lang)}刪除失敗：${e instanceof Error ? e.message : '請重試'}`,
      )
    } finally {
      setPackBusy(null)
    }
  }

  async function handleCapture() {
    setNotice('')
    setBusy('processing')
    try {
      const result: CaptureResult = await captureAndTranslate({
        sourceLang: source,
        targetLang: target,
      })
      switch (result.status) {
        case 'saved':
          refreshCards()
          setNotice('已加入收藏夾 ✓')
          break
        case 'no-text':
          setNotice('照片中沒有辨識到文字')
          break
        case 'cancelled':
          break
        case 'error':
          setNotice(`失敗：${result.message}`)
          break
      }
    } catch (e) {
      // 保險：流程內未預期的例外也要顯示，不可靜默
      setNotice(
        `程式錯誤：${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBusy(null)
    }
  }

  function handleDelete(id: string) {
    deleteCard(id)
    refreshCards()
  }

  async function handleTranslate() {
    if (!input.trim()) return
    setTextError('')
    setOutput('')
    setBusy('translating')
    try {
      await ensureModelsReady(source, target, {
        onProgress: ({ language }) => {
          setBusy('downloading')
          setNotice(`正在下載${languageName(language)}語言包…`)
        },
      })
      setNotice('')
      const result = await translateText(input, source, target)
      setOutput(result)
    } catch (e) {
      setTextError(e instanceof Error ? e.message : '翻譯失敗')
    } finally {
      setBusy(null)
      setNotice('')
    }
  }

  function swapLanguages() {
    setSource(target)
    setTarget(source)
  }

  const langSelectors = (label: string) => (
    <>
      <select
        value={source}
        onChange={(e) => setSource(e.target.value)}
        aria-label="來源語言"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
      <button className="swap" onClick={swapLanguages} aria-label="交換語言">
        ⇄
      </button>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label={label}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </>
  )

  return (
    <div className="app">
      <header className="app-header">
        <h1>旅遊翻譯本</h1>
        <p className="tagline">離線拍照翻譯 · 資料不出裝置</p>
      </header>

      <nav className="tabs" aria-label="功能頁籤">
        <button
          className={tab === 'collection' ? 'tab active' : 'tab'}
          onClick={() => setTab('collection')}
        >
          收藏夾
        </button>
        <button
          className={tab === 'text' ? 'tab active' : 'tab'}
          onClick={() => setTab('text')}
        >
          文字翻譯
        </button>
        <button
          className={tab === 'packs' ? 'tab active' : 'tab'}
          onClick={() => setTab('packs')}
        >
          語言包
        </button>
      </nav>

      {notice && <p className="notice">{notice}</p>}

      {tab === 'collection' && (
        <main className="collection">
          <div className="capture-panel">
            <div className="lang-row">{langSelectors('目標語言')}</div>
            <button
              className="capture-btn"
              onClick={handleCapture}
              disabled={busy !== null}
            >
              📷 {busy === 'processing' ? '處理中…' : '拍照翻譯'}
            </button>
          </div>

          {cards.length === 0 ? (
            <div className="empty">
              <p className="empty-icon">🗺️</p>
              <p>
                拍下菜單、路標、看板
                <br />
                翻譯會收藏在這裡
              </p>
            </div>
          ) : (
            <ul className="card-list">
              {cards.map((c) => (
                <li key={c.id} className="travel-card">
                  <img
                    src={c.photoWebPath ?? c.photoPath}
                    alt="拍攝照片"
                    className="card-photo"
                  />
                  <div className="card-body">
                    <p className="card-translation">{c.translatedText}</p>
                    <p className="card-ocr">{c.ocrText}</p>
                    <p className="card-meta">
                      {languageName(c.sourceLang)} → {languageName(c.targetLang)}
                    </p>
                    <button
                      className="card-delete"
                      onClick={() => handleDelete(c.id)}
                      aria-label="刪除卡片"
                    >
                      刪除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
      )}
      {tab === 'text' && (
        <main className="text-tab">
          <div className="lang-row">{langSelectors('目標語言')}</div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="輸入要翻譯的文字…"
            rows={5}
          />

          <button
            className="translate-btn"
            onClick={handleTranslate}
            disabled={busy !== null}
          >
            {busy === 'downloading'
              ? '下載語言包中…'
              : busy === 'translating'
                ? '翻譯中…'
                : '翻譯'}
          </button>

          {textError && <p className="error">{textError}</p>}

          <div className="result">
            <h2>翻譯結果</h2>
            <p className="output">{output || '—'}</p>
          </div>
        </main>
      )}
      {tab === 'packs' && (
        <main className="packs-tab">
          <p className="packs-hint">
            每個語言包約 30MB，下載後該語言即可離線翻譯。
            建議出國前在 WiFi 環境預先下載。
          </p>
          {packError && <p className="error">{packError}</p>}
          <ul className="pack-list">
            {LANGUAGES.map((l) => {
              const isDownloaded = downloadedLangs.includes(l.code)
              const isBusy = packBusy === l.code
              return (
                <li key={l.code} className="pack-item">
                  <span className="pack-name">
                    {l.name}
                    {isDownloaded && <em className="pack-badge">已下載</em>}
                  </span>
                  {isDownloaded ? (
                    <button
                      className="pack-remove"
                      onClick={() => handleRemove(l.code)}
                      disabled={packBusy !== null}
                      aria-label={`刪除${l.name}語言包`}
                    >
                      {isBusy ? '處理中…' : '刪除'}
                    </button>
                  ) : (
                    <button
                      className="pack-download"
                      onClick={() => handleDownload(l.code)}
                      disabled={packBusy !== null}
                      aria-label={`下載${l.name}語言包`}
                    >
                      {isBusy ? '下載中…' : '下載'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </main>
      )}

      <footer>
        <p>
          翻譯與辨識完全在你的裝置上執行（ML Kit + OpenCC）。
          唯一的網路行為：首次使用的語言包下載。
        </p>
      </footer>
    </div>
  )
}

export default App
