import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { translateText } from './services/translationService'
import { ensureModelsReady } from './services/modelManager'
import { captureAndTranslate, type CaptureResult } from './services/photoFlow'
import { listCards, deleteCard, type TravelCard } from './services/cardStore'
import { LANGUAGES, languageName } from './languages'

type Tab = 'collection' | 'text'
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

  const refreshCards = useCallback(() => setCards(listCards()), [])

  useEffect(() => {
    refreshCards()
  }, [refreshCards])

  async function handleCapture() {
    setNotice('')
    setBusy('processing')
    const result: CaptureResult = await captureAndTranslate({
      sourceLang: source,
      targetLang: target,
    })
    setBusy(null)
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
      </nav>

      {notice && <p className="notice">{notice}</p>}

      {tab === 'collection' ? (
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
      ) : (
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
