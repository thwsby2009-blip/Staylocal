import { useState } from 'react'
import './App.css'
import { translateText } from './services/translationService'
import { ensureModelsReady } from './services/modelManager'
import { LANGUAGES, languageName } from './languages'

type Phase = 'idle' | 'downloading' | 'translating' | 'error'

function App() {
  const [source, setSource] = useState('en')
  const [target, setTarget] = useState('zh')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleTranslate() {
    if (!input.trim()) return
    setErrorMsg('')
    setOutput('')
    setPhase('translating')
    try {
      // 先確保語言包存在（缺的會在此下載，各約 30MB）
      const r = await ensureModelsReady(source, target, {
        onProgress: ({ language }) => {
          setPhase('downloading')
          setStatusMsg(`正在下載${languageName(language)}語言包（約 30MB）…`)
        },
      })
      if (r.status === 'downloaded') {
        setStatusMsg('語言包已就緒')
      } else {
        setStatusMsg('')
      }

      setPhase('translating')
      const result = await translateText(input, source, target)
      setOutput(result)
      setPhase('idle')
      setStatusMsg('')
    } catch (e) {
      setPhase('error')
      setErrorMsg(
        e instanceof Error ? e.message : '翻譯失敗，請確認語言包已下載',
      )
    }
  }

  function swapLanguages() {
    setSource(target)
    setTarget(source)
  }

  return (
    <div className="app">
      <header>
        <h1>離線翻譯</h1>
        <p className="subtitle">100% 裝置端翻譯 · 不需網路 · 資料不上傳</p>
      </header>

      <div className="lang-row">
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
        <button onClick={swapLanguages} aria-label="交換語言">
          ⇄
        </button>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="目標語言"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="輸入要翻譯的文字…"
        rows={5}
      />

      <button
        className="translate-btn"
        onClick={handleTranslate}
        disabled={phase === 'translating' || phase === 'downloading'}
      >
        {phase === 'downloading'
          ? '下載語言包中…'
          : phase === 'translating'
            ? '翻譯中…'
            : '翻譯'}
      </button>

      {statusMsg && <p className="status">{statusMsg}</p>}
      {errorMsg && <p className="error">{errorMsg}</p>}

      <div className="result">
        <h2>翻譯結果</h2>
        <p className="output">{output || '—'}</p>
      </div>

      <footer>
        <p>
          翻譯完全在你的裝置上執行（ML Kit + OpenCC）。
          唯一的網路行為是首次使用的語言包下載（Google 伺服器）。
        </p>
      </footer>
    </div>
  )
}

export default App
