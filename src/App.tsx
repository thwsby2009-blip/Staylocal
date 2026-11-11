import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import {
  translateText,
  toTaiwanTraditional,
  isChinese,
} from './services/translationService'
import {
  ensureModelsReady,
  getDownloadedLanguages,
  downloadLanguage,
  removeLanguage,
} from './services/modelManager'
import { captureAndTranslate, type CaptureResult } from './services/photoFlow'
import { listCards, deleteCard, type TravelCard } from './services/cardStore'
import { LANGUAGES, languageName } from './languages'
import {
  startRecording as startSpeechRecording,
  stopRecordingAndTranscribe,
  isSpeechSupported,
  getSpeechDiagnostics,
  getSpeechSupportInfo,
  formatSupportInfo,
  triggerOnDeviceModelDownload,
  speechLocaleFor,
  toLangList,
  getAsrModelStatus,
  downloadAsrModel,
  deleteAsrModel,
  clearPreviousDictation,
  getLiveModelStatus,
  downloadVadModel,
  downloadWhisperModel,
  startLiveTranslation,
  stopLiveTranslation,
  addLiveSegmentListener,
  addLiveStatusListener,
  liveEngineFor,
  isSenseVoiceLanguage,
  WHISPER_SIZES,
  WHISPER_SIZE_LABEL,
  type WhisperSize,
  type AsrModelStatus,
  type DictationSnapshot,
  type LiveModelStatus,
} from './services/speechService'

type Tab = 'collection' | 'live' | 'text' | 'packs'

/** 即時翻譯的一列字幕（原文＋譯文＋延遲） */
interface LiveRow {
  id: number
  src: string
  dst: string
  lang: string
  audioMs: number
  asrMs: number
  mtMs: number
  pending: boolean
  error?: string
}
type Busy = null | 'downloading' | 'translating' | 'processing'

function App() {
  const [tab, setTab] = useState<Tab>('collection')

  // 收藏夾
  const [cards, setCards] = useState<TravelCard[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<Busy>(null)

  // 文字翻譯（語言選擇記在裝置上，App 重啟不重置）
  const [source, setSource] = useState(
    () => localStorage.getItem('ot_source') ?? 'en',
  )
  const [target, setTarget] = useState(
    () => localStorage.getItem('ot_target') ?? 'zh',
  )
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [textError, setTextError] = useState('')

  // 語音聽寫（批次：先錄音存檔 → 停止後轉逐字稿）
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const speechBaseRef = useRef('')
  // 上一次聽寫的快照（下次錄音前要先清掉舊逐字稿，否則每次結果都往上疊）
  const lastDictationRef = useRef<DictationSnapshot | null>(null)

  // 高準度離線語音模型（SenseVoice，選配）
  const [asrStatus, setAsrStatus] = useState<AsrModelStatus | null>(null)
  const [asrProgress, setAsrProgress] = useState<number | null>(null)
  const [asrBusy, setAsrBusy] = useState(false)

  // 即時翻譯（連續收音 → 逐句辨識 → 逐句翻譯）
  const [liveOn, setLiveOn] = useState(false)
  const [liveRows, setLiveRows] = useState<LiveRow[]>([])
  const [liveError, setLiveError] = useState('')
  const [liveModel, setLiveModel] = useState<LiveModelStatus | null>(null)
  const [vadBusy, setVadBusy] = useState(false)
  const [whisperBusy, setWhisperBusy] = useState(false)
  const [whisperProgress, setWhisperProgress] = useState<number | null>(null)
  // 多語模型品質（tiny/base/small）：記在裝置上，重啟不重置
  const [whisperSize, setWhisperSize] = useState<WhisperSize>(
    // 實測：base 相似度 0.64／small 0.78（同片對照），故預設 small
    () => (localStorage.getItem('ot_whisper_size') as WhisperSize) || 'small',
  )
  // 事件回呼裡要用「當下的」語言對；用 ref 避免拿到過期的 state
  const livePairRef = useRef({ source, target })
  const liveIdRef = useRef(0)

  // 錄音計時（顯示錄了多久）
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [recording])

  // 開頁時查一次高準度模型狀態（瀏覽器預覽時回 null）
  useEffect(() => {
    getAsrModelStatus().then(setAsrStatus)
    getLiveModelStatus().then(setLiveModel)
  }, [])

  // 語言對隨時同步到 ref（事件回呼要用最新的）
  useEffect(() => {
    livePairRef.current = { source, target }
  }, [source, target])

  // 逐句辨識結果 → 逐句翻譯 → 更新字幕列（原生端只送辨識，翻譯在 JS 端做）
  useEffect(() => {
    const segHandle = addLiveSegmentListener(async (seg) => {
      const { source: srcLang, target: tgtLang } = livePairRef.current
      const id = ++liveIdRef.current
      setLiveRows((prev) => [
        {
          id,
          src: seg.text,
          dst: '',
          lang: seg.language,
          audioMs: seg.audioMs,
          asrMs: seg.inferenceMs,
          mtMs: 0,
          pending: true,
        },
        ...prev,
      ])
      const t0 = performance.now()
      try {
        const translated = await translateText(seg.text, srcLang, tgtLang)
        const mtMs = Math.round(performance.now() - t0)
        setLiveRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, dst: translated, mtMs, pending: false } : r)),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : '翻譯失敗'
        setLiveRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, pending: false, error: msg } : r)),
        )
      }
    })
    const statusHandle = addLiveStatusListener((st) => {
      if (st.state === 'error') {
        setLiveError(st.message ?? '即時辨識發生錯誤')
        setLiveOn(false)
      }
      if (st.state === 'stopped') setLiveOn(false)
    })
    return () => {
      void segHandle.then((h) => h.remove())
      void statusHandle.then((h) => h.remove())
    }
  }, [])

  // 記住語言選擇（重啟後不重置）
  useEffect(() => {
    localStorage.setItem('ot_source', source)
  }, [source])
  useEffect(() => {
    localStorage.setItem('ot_target', target)
  }, [target])
  useEffect(() => {
    localStorage.setItem('ot_whisper_size', whisperSize)
  }, [whisperSize])

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

  // ===== 語音聽寫（離線）=====

  // 失敗訊息組裝：基礎訊息 + 系統診斷 + 官方支援查詢（缺模型則自動觸發下載）
  async function speechFailureText(base: string, lang: string): Promise<string> {
    const parts = [base]
    const diag = await getSpeechDiagnostics()
    if (diag) {
      parts.push(
        `[診斷] available=${diag.available}\n辨識活動=${JSON.stringify(diag.speechActivities)}\n` +
          `辨識服務=${JSON.stringify(diag.recognitionServices)}\n預設服務=${diag.defaultService || '（無）'}`,
      )
    }
    const info = await getSpeechSupportInfo()
    if (info) {
      parts.push(`[支援查詢]\n${formatSupportInfo(info)}`)
      const want = speechLocaleFor(lang).toLowerCase()
      const has = (arr: unknown) =>
        toLangList(arr).some((l) => l.toLowerCase() === want)
      if (
        !has(info.installedOnDeviceLanguages) &&
        has(info.supportedOnDeviceLanguages)
      ) {
        const msg = await triggerOnDeviceModelDownload(speechLocaleFor(lang))
        if (msg) parts.push(`${msg}；完成後再按一次語音輸入`)
      }
    }
    return parts.join('\n\n')
  }

  async function handleDownloadAsrModel() {
    setAsrBusy(true)
    setAsrProgress(0)
    setTextError('')
    setNotice('正在下載高準度語音模型（約 240MB，請保持網路連線）…')
    try {
      const mb = await downloadAsrModel((p) => {
        setAsrProgress(p.percent >= 0 ? p.percent : null)
      })
      setAsrStatus(await getAsrModelStatus())
      setLiveModel(await getLiveModelStatus())
      setNotice(`高準度語音模型下載完成（${mb}MB），之後的錄音會自動使用它`)
    } catch (e) {
      setTextError(e instanceof Error ? e.message : '模型下載失敗')
      setNotice('')
    } finally {
      setAsrBusy(false)
      setAsrProgress(null)
    }
  }

  async function handleDeleteAsrModel() {
    setAsrBusy(true)
    try {
      await deleteAsrModel()
      setAsrStatus(await getAsrModelStatus())
      setNotice('已移除高準度語音模型（改用系統語音輸入）')
    } finally {
      setAsrBusy(false)
    }
  }

  async function handleDictate() {
    // 按第二次 = 停止錄音 → 轉逐字稿（批次）
    if (recording) {
      setRecording(false)
      setTranscribing(true)
      setNotice('正在把錄音轉成逐字稿…')
      try {
        const res = await stopRecordingAndTranscribe(source, {
          preferSenseVoice: true,
        })
        let text = res.text.trim()
        // 高準度模型的中文輸出為簡體 → 轉台灣繁體（沿用翻譯用的 OpenCC）
        if (text && res.engine === 'sensevoice' && isChinese(source)) {
          text = toTaiwanTraditional(text)
        }
        if (text) {
          const nextInput = [speechBaseRef.current, text]
            .filter(Boolean)
            .join('\n')
          lastDictationRef.current = {
            expected: nextInput,
            base: speechBaseRef.current,
          }
          setInput(nextInput)
          setNotice(
            `逐字稿完成（錄音 ${Math.round(res.seconds)} 秒${
              res.engine === 'sensevoice' ? '・高準度模型' : ''
            }）`,
          )
        } else {
          setInput(speechBaseRef.current)
          setNotice('沒有辨識到語音內容（可能太小聲或沒收到聲音）')
        }
      } catch (e) {
        const base = e instanceof Error ? e.message : '轉逐字稿失敗'
        setInput(speechBaseRef.current)
        if (base.includes('沒有聽到可辨識的語音')) {
          // 有錄到音但辨識不到：最常見是來源語言選錯
          setNotice(
            `沒有辨識到語音內容 —— 請確認「來源語言」是否選對（目前：${languageName(source)}），或靠近麥克風再講一次`,
          )
        } else {
          setTextError(await speechFailureText(base, source))
        }
      } finally {
        setTranscribing(false)
        setRecordSeconds(0)
      }
      return
    }
    if (transcribing) return
    if (busy !== null) return
    if (!isSpeechSupported(source)) {
      setTextError(`「${languageName(source)}」暫不支援語音輸入，請用打字或改選英文`)
      return
    }
    setTextError('')
    // 新的一次錄音：先清掉上一次的逐字稿，避免每次結果一直往上疊。
    // 僅在輸入框與上次聽寫結果完全相同（使用者沒動過）時清回聽寫前內容；
    // 使用者改過就原樣保留，不覆寫人工編輯。
    const base = clearPreviousDictation(input, lastDictationRef.current)
    if (base !== input) setInput(base)
    lastDictationRef.current = null
    speechBaseRef.current = base // 基底 = 這次錄音開始時的內容

    // 預檢：端側模型必須已安裝才進聽寫（缺模型時引擎會靜默 no-match，講了也白講）
    try {
      const info = await getSpeechSupportInfo()
      if (info) {
        const want = speechLocaleFor(source).toLowerCase()
        const norm = (arr: unknown) =>
          toLangList(arr).map((l) => l.toLowerCase())
        const installed = norm(info.installedOnDeviceLanguages)
        const supported = norm(info.supportedOnDeviceLanguages)
        const pending = norm(info.pendingOnDeviceLanguages)
        if (!installed.includes(want)) {
          if (supported.includes(want)) {
            const msg = await triggerOnDeviceModelDownload(
              speechLocaleFor(source),
            )
            setTextError(
              `${msg ?? '已觸發端側語音模型下載'}\n下載完成後再按一次「🎤 語音輸入」。\n（下載需要 WiFi 網路，模型約數十 MB）`,
            )
          } else if (pending.includes(want)) {
            setTextError(
              `「${speechLocaleFor(source)}」端側語音模型下載中，請稍後再按一次「🎤 語音輸入」。`,
            )
          } else {
            setTextError(
              `此裝置的端側辨識不支援「${speechLocaleFor(source)}」，請改用其他來源語言。`,
            )
          }
          return
        }
      }
    } catch {
      // 預檢失敗不阻擋（讓後續流程自行回報）
    }

    try {
      // 只開始錄音，不做辨識；停止後才整段轉逐字稿
      await startSpeechRecording((partialText) => {
        // 轉寫階段的即時逐字稿（native 在轉檔期間持續送出）
        setInput(
          [speechBaseRef.current, partialText].filter(Boolean).join('\n'),
        )
      })
      setRecording(true)
      setRecordSeconds(0)
    } catch (e) {
      const base = e instanceof Error ? e.message : '錄音啟動失敗'
      setTextError(await speechFailureText(base, source))
    }
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

  // ===== 即時翻譯 =====

  async function handleDownloadWhisper() {
    setWhisperBusy(true)
    setWhisperProgress(0)
    setLiveError('')
    setNotice(`正在下載多語模型 ${whisperSize}（${WHISPER_SIZE_LABEL[whisperSize]}）…`)
    try {
      const mb = await downloadWhisperModel(whisperSize, (p) => {
        setWhisperProgress(p.percent >= 0 ? p.percent : null)
        setNotice(
          `正在下載多語模型 ${whisperSize}：${p.file}${
            p.percent >= 0 ? `（${p.percent}%）` : ''
          }`,
        )
      })
      setLiveModel(await getLiveModelStatus())
      setNotice(`多語模型 ${whisperSize} 下載完成（${mb}MB）——瑞典文／丹麥文等語言現在可以即時翻譯了`)
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : '多語模型下載失敗')
      setNotice('')
    } finally {
      setWhisperBusy(false)
      setWhisperProgress(null)
    }
  }

  async function handleDownloadVad() {
    setVadBusy(true)
    setLiveError('')
    try {
      const mb = await downloadVadModel()
      setLiveModel(await getLiveModelStatus())
      setNotice(`句切模型下載完成（${mb || 2}MB）`)
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : '句切模型下載失敗')
    } finally {
      setVadBusy(false)
    }
  }

  async function handleToggleLive() {
    setLiveError('')
    if (liveOn) {
      setLiveOn(false)
      try {
        await stopLiveTranslation()
      } catch {
        // 停止失敗不影響 UI（原生端會自行收尾）
      }
      return
    }
    const status = liveModel ?? (await getLiveModelStatus())
    if (!status) {
      setLiveError('無法查詢模型狀態（請稍後再試）')
      return
    }
    // 語言 → 引擎：中英日韓粵走 SenseVoice，其餘走 Whisper 多語
    const engine = liveEngineFor(source, !!status.whisperInstalled?.[whisperSize])
    if (engine === null) {
      setLiveError(
        `「${languageName(source)}」需要「多語模型 ${whisperSize}」才能即時聽寫，請先在下方下載`,
      )
      return
    }
    if (engine === 'sensevoice' && !status.asrInstalled) {
      setLiveError('即時翻譯需要「高準度離線語音模型」（約 240MB），請先在下方下載')
      return
    }
    if (!status.vadInstalled) {
      setLiveError('即時翻譯需要「句切模型」（約 2MB），請先在下方下載')
      return
    }
    // 翻譯語言包要先備好，否則每句都會卡在下載
    try {
      await ensureModelsReady(source, target, {
        onProgress: ({ language }) => {
          setNotice(`正在下載${languageName(language)}語言包…`)
        },
      })
      setNotice('')
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : '語言包下載失敗')
      return
    }
    try {
      // 直接傳來源語言碼與多語模型尺寸：原生端自行判斷走 SenseVoice 或 Whisper
      const r = await startLiveTranslation(source, whisperSize)
      setLiveOn(true)
      setNotice(
        `即時翻譯中（${r.audioSource === 6 ? '原始收音 UNPROCESSED' : 'MIC'}）——講完一句停頓一下就會出譯文`,
      )
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : '即時翻譯啟動失敗')
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

  // 即時頁的模型需求（依目前選的來源語言決定要不要多語模型）
  const srcIsSvLang = isSenseVoiceLanguage(source)
  const liveNeedVad = !liveModel?.vadInstalled
  const liveNeedSv = srcIsSvLang && !liveModel?.asrInstalled
  const liveNeedWhisper = !srcIsSvLang && !liveModel?.whisperInstalled?.[whisperSize]

  return (
    <div className="app">
      <header className="app-header">
        <h1>旅行翻譯小助手</h1>
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
          className={tab === 'live' ? 'tab active' : 'tab'}
          onClick={() => setTab('live')}
        >
          即時
          <br />
          翻譯
        </button>
        <button
          className={tab === 'text' ? 'tab active' : 'tab'}
          onClick={() => setTab('text')}
        >
          文字
          <br />
          翻譯
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
            placeholder={
              recording
                ? '錄音中…按「停止錄音」後會轉成逐字稿'
                : transcribing
                  ? '正在把錄音轉成逐字稿…'
                  : '輸入要翻譯的文字…'
            }
            rows={5}
          />

          <div className="input-actions">
            <button
              className={recording ? 'dictate-btn recording' : 'dictate-btn'}
              onClick={handleDictate}
              disabled={busy !== null || transcribing}
              aria-label={recording ? '停止錄音' : '開始錄音'}
            >
              {transcribing
                ? '⏳ 轉逐字稿中…'
                : recording
                  ? `⏹ 停止錄音（${recordSeconds}s）`
                  : '🎤 錄音轉逐字稿'}
            </button>
            <button
              className="translate-btn"
              onClick={handleTranslate}
              disabled={busy !== null || recording || transcribing}
            >
              {busy === 'downloading'
                ? '下載語言包中…'
                : busy === 'translating'
                  ? '翻譯中…'
                  : '翻譯'}
            </button>
          </div>

          <div className="asr-model-card">
            {asrStatus?.installed ? (
              <>
                <div className="asr-model-row">
                  <span className="asr-model-title">🎯 高準度語音模型已啟用</span>
                  <button
                    className="asr-model-btn"
                    onClick={handleDeleteAsrModel}
                    disabled={asrBusy}
                  >
                    移除（釋放 {asrStatus.sizeMb}MB）
                  </button>
                </div>
                <p className="asr-model-hint">
                  中文逐字稿會自動改用此模型（自動加標點、準度較好）
                </p>
              </>
            ) : (
              <>
                <div className="asr-model-row">
                  <span className="asr-model-title">🎯 高準度離線語音模型</span>
                  <button
                    className="asr-model-btn primary"
                    onClick={handleDownloadAsrModel}
                    disabled={asrBusy}
                  >
                    {asrBusy
                      ? `下載中 ${asrProgress === null ? '…' : `${asrProgress}%`}`
                      : '下載（約 240MB）'}
                  </button>
                </div>
                <p className="asr-model-hint">
                  選配：中文（及日/韓/英/粵）辨識品質明顯較好、自動加標點。下載一次即可離線使用；不下載也能用系統語音輸入。
                </p>
              </>
            )}
          </div>

          {textError && <p className="error">{textError}</p>}

          <div className="result">
            <h2>翻譯結果</h2>
            <p className="output">{output || '—'}</p>
          </div>
        </main>
      )}
      {tab === 'live' && (
        <main className="live-tab">
          <div className="lang-row">{langSelectors('目標語言')}</div>

          <button
            className={liveOn ? 'live-btn on' : 'live-btn'}
            onClick={handleToggleLive}
          >
            {liveOn ? '⏹ 停止即時翻譯（收音中）' : '🎙️ 開始即時翻譯'}
          </button>

          <p className="live-hint">
            講完一句、停頓約半秒，該句的原文與譯文就會出現。辨識與翻譯全程在裝置上執行。
          </p>

          {/* 模型卡常駐：已安裝時也要能切換尺寸／下載其他尺寸 */}
          <div className="asr-model-card">
              <div className="asr-model-row">
                <span className="asr-model-title">🧩 即時翻譯所需模型</span>
                <button
                  className="asr-model-btn"
                  onClick={() => getLiveModelStatus().then(setLiveModel)}
                  disabled={vadBusy || asrBusy || whisperBusy}
                >
                  重新檢查
                </button>
              </div>
              {!srcIsSvLang && (
                <div className="asr-model-row">
                  <span className="asr-model-title">多語模型品質</span>
                  <div className="size-picker">
                    {WHISPER_SIZES.map((s) => (
                      <button
                        key={s}
                        className={whisperSize === s ? 'size-btn active' : 'size-btn'}
                        onClick={() => setWhisperSize(s)}
                        disabled={whisperBusy}
                      >
                        {s}
                        {liveModel?.whisperInstalled?.[s] ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p className="asr-model-hint">
                {srcIsSvLang ? (
                  <>
                    高準度語音模型（中／英／日／韓／粵）：
                    {liveModel?.asrInstalled ? '已安裝 ✓' : '未安裝（約 240MB）'}
                    <br />
                  </>
                ) : (
                  <>
                    多語模型 {whisperSize}（{languageName(source)} 等語言）：
                    {liveModel?.whisperInstalled?.[whisperSize] ? '已安裝 ✓' : '未安裝'}
                    <br />
                  </>
                )}
                句切模型：{liveModel?.vadInstalled ? '已安裝 ✓' : '未安裝（約 2MB）'}
              </p>
              <div className="asr-model-row">
                {liveNeedSv && (
                  <button
                    className="asr-model-btn primary"
                    onClick={handleDownloadAsrModel}
                    disabled={asrBusy}
                  >
                    {asrBusy
                      ? `下載中 ${asrProgress === null ? '…' : `${asrProgress}%`}`
                      : '下載語音模型（240MB）'}
                  </button>
                )}
                {liveNeedWhisper && (
                  <button
                    className="asr-model-btn primary"
                    onClick={handleDownloadWhisper}
                    disabled={whisperBusy}
                  >
                    {whisperBusy
                      ? `下載中${whisperProgress === null ? '…' : ` ${whisperProgress}%`}`
                      : `下載多語模型 ${whisperSize}`}
                  </button>
                )}
                {liveNeedVad && (
                  <button
                    className="asr-model-btn primary"
                    onClick={handleDownloadVad}
                    disabled={vadBusy}
                  >
                    {vadBusy ? '下載中…' : '下載句切模型（2MB）'}
                  </button>
                )}
              </div>
          </div>

          {liveError && <p className="error">{liveError}</p>}

          {liveRows.length === 0 ? (
            <div className="empty">
              <p className="empty-icon">🎧</p>
              <p>
                按「開始即時翻譯」後
                <br />
                原文與譯文會一句一句出現在這裡
              </p>
            </div>
          ) : (
            <ul className="live-list">
              {liveRows.map((r) => (
                <li key={r.id} className="live-item">
                  <p className="live-src">{r.src}</p>
                  <p className="live-dst">
                    {r.error ? `⚠ ${r.error}` : r.pending ? '翻譯中…' : r.dst}
                  </p>
                  <p className="live-meta">
                    {r.lang ? `${r.lang.toUpperCase()} · ` : ''}音訊 {r.audioMs}ms · 辨識{' '}
                    {r.asrMs}ms · 翻譯 {r.pending ? '…' : `${r.mtMs}ms`}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {liveRows.length > 0 && (
            <button className="live-clear" onClick={() => setLiveRows([])}>
              清空字幕
            </button>
          )}
        </main>
      )}
      {tab === 'packs' && (
        <main className="packs-tab">
          <p className="packs-hint">
            每個語言包約 50MB（實測 en/ja/ko/zh 各約 50MB），下載後該語言即可離線翻譯。
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
        <p className="build-tag">build v29 · 即時翻譯獨立頁（2026-11-10）</p>
      </footer>
    </div>
  )
}

export default App
