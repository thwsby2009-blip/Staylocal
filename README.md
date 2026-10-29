# 離線翻譯 / Offline Translator

完全離線的手機翻譯 app：拍照或輸入文字，翻譯全部在你的裝置上完成。零 API key、零帳號、零資料上傳。

**應用場景以旅遊為主**——菜單、路標、看板即拍即譯，譯文與照片一起收藏；任何無網路的場合（飛航、國外無漫遊、機密環境）同樣適用。UI 因此採旅遊相簿風格。

A fully offline mobile translation app. Photo or text — everything runs on your device. No API keys, no accounts, no data uploaded. Travel is its primary use case (menus, signs, notices saved as a photo deck), but it works anywhere without a network.

## 功能 / Features

- **📷 拍照翻譯**：拍下菜單、路標、看板 → 端側 OCR 辨識文字 → 自動翻譯 → 存成旅遊卡片收藏
- **🗺️ 收藏夾**：照片與譯文一起保存，之後可翻看、刪除
- **⌨️ 文字翻譯**：51 種語言互譯，中文輸出自動轉台灣用字繁體（含詞彙轉換，如 software → 軟體）
- **📦 語言包管理**：預先下載旅遊目的地語言包（各約 30MB），刪除釋放空間
- **🎤 語音轉逐字稿**：錄音後端側轉文字（全離線），逐字稿可直接續接翻譯；中文／日／韓／英／粵另可選配**高準度模型**（SenseVoice，約 240MB，首次使用時下載，自動加標點）

## 截圖 / Screenshots

> 以下為 Android 實機畫面。狀態列的 ✈️ 圖示表示**飛航模式**——辨識、翻譯全部照常運作。

| 收藏夾：拍照翻譯入口 | 文字翻譯（✈️ 飛航模式） |
|---|---|
| <img src="screenshots/01-collection.jpg" width="320"> | <img src="screenshots/02-text-translation-offline.jpg" width="320"> |

| 長文翻譯結果（✈️ 飛航模式） | 語言包管理 |
|---|---|
| <img src="screenshots/03-translation-result-offline.jpg" width="320"> | <img src="screenshots/04-language-packs.jpg" width="320"> |

## 架構 / How it works

```
拍照/選圖 ──→ ML Kit Text Recognition v2（端側 OCR，模型綁 APK）
                │
輸入文字 ───────┤
                │
錄音（16kHz WAV）→ 端側語音辨識 ┤（系統 On-Device 引擎；已裝 SenseVoice 時改用 sherpa-onnx）
                ▼
        ML Kit Translation（端側翻譯，Google Translate 離線同款模型）
                │
                ▼
        OpenCC cn→twp（簡體 → 台灣用字繁體，含詞彙轉換）
```

- 所有辨識與翻譯**完全在裝置上執行**，飛航模式可用
- 語音走批次架構：`AudioRecord`（**原始未處理收音**，避免 Google 專屬降噪鏈讓其他模型聽不懂）錄成 WAV，停止後才把音檔餵給辨識器
- 選配的 SenseVoice 由 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 在裝置端推論；模型檔在使用者裝置上首次下載，**不隨 APK 散布**
- 唯一的網路行為：首次使用時從 Google 伺服器下載翻譯語言包（OCR 模型直接綁在 APK 內，免下載）
- 照片存在 app 私有目錄，卡片 metadata 存 localStorage，不出裝置

## 技術棧 / Tech Stack

- [Capacitor](https://capacitorjs.com/) 8 + React + TypeScript + Vite
- [@capacitor-mlkit/translation](https://github.com/capawesome-team/capacitor-mlkit)（ML Kit on-device translation）
- [@capacitor-mlkit/text-recognition](https://github.com/capawesome-team/capacitor-mlkit)（ML Kit Text Recognition v2）
- [opencc-js](https://github.com/nk2028/opencc-js)（s2twp：簡體→台灣繁體＋詞彙轉換）
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（離線語音辨識推論，Apache-2.0；AAR 不進版控，需先跑 `bash scripts/fetch-deps.sh`）
- Vitest（55 個單元測試）

## 已知限制 / Known Limitations

- **非英文對經英文樞紐**：ML Kit 的非英文翻譯對會經英文中繼（如泰→日 = 泰→英→日），品質打折；主流對（中英、中日）無此問題
- **離線翻譯品質**：等同 Google Translate 離線模式，長句通順度低於雲端 LLM 翻譯
- **OCR script 需選對來源語言**：ML Kit 按文字系統（Latin/中文/日文/韓文）分模型，拍照前請先選對來源語言
- **中文輸出為簡體**：ML Kit 限制，本 app 已用 OpenCC 自動轉台灣繁體
- **系統端側語音辨識品質有限**：內建模型偏向短句／指令、無標點、長段口語易漏字；要好的中文逐字稿請下載選配的 SenseVoice 模型

## 開發 / Development

```bash
npm install
npx cap init   # 首次
npx cap add android
bash scripts/fetch-deps.sh   # 原生相依（sherpa-onnx AAR，49MB，不進版控）
npm run build
npx cap sync android

# 單元測試
npx vitest run

# Android APK（在 android/ 目錄）
gradlew.bat assembleDebug
```

- 需 Node 18+、Android SDK
- 翻譯與 OCR 在瀏覽器（`npm run dev`）預覽時不可用，需實機或模擬器

## 授權 / License

程式碼：[MIT](LICENSE)

執行時期使用的第三方元件：
- ML Kit（Google，[ML Kit Terms](https://developers.google.com/ml-kit/terms)）
- OpenCC 詞庫（Apache-2.0 / CC BY-SA 3.0，見 [opencc-js](https://github.com/nk2028/opencc-js)）
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 執行期（Apache-2.0，以 AAR 形式連結）
- SenseVoice 模型權重（[FunASR Model License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)）：由使用者在裝置上自行下載，本專案不散布模型檔
