# 離線翻譯 × 逐字稿 長文測試包（2026-10-28）

> 目的：逐字稿（數千字）直接貼進「旅行翻譯小助手」的行為驗證。
> App 現況：`translationService.ts` 整段原文一次送 ML Kit，無任何分段。
> 已知雷點：ML Kit 會剝掉換行；長文延遲/截斷/記憶體行為未驗證。

## 測試前準備

1. 語言包：確保「英文→中文」語言包已下載（語言包頁看得到「已下載」）
2. 開飛航模式（測純離線，順便重現 README 的宣稱）
3. 手機計時器備用

---

## 測試 A：多段落短文（約 150 字，先驗換行與基本品質）

把下面整塊（含空行）複製 → 文字翻譯 → 貼上 → 翻譯：

```
Hi everyone, welcome back. Today I want to talk about my trip to Kyoto last spring.

We stayed near Kyoto Station for five days. The hotel cost about 12,000 yen per night, which was reasonable for the location.

The best place we visited was Fushimi Inari. We arrived at 7 a.m. and the gates were almost empty. By 10 a.m. the crowds were everywhere, so go early.

If you only have one day in Kyoto, I recommend three stops: the bamboo forest, Kiyomizu temple, and Nishiki Market for lunch.
```

**記錄：**
- [ ] 耗時：____ 秒
- [ ] 輸出是「一整坨」還是保留段落？（ML Kit 已知會剝換行）
- [ ] 數字（12,000 yen、7 a.m.、10 a.m.）與地名（Kyoto、Fushimi Inari）有沒有錯？
- [ ] 結尾有沒有翻完？（對照原文最後一句 Nishiki Market）

---

## 測試 B：逐字稿級長文（約 460 字 ≈ 2,800 字元，模擬 3-5 分鐘錄音）

整塊複製 → 貼上 → 翻譯。**按下翻譯的同時開始計時。**

```
Good morning everyone, thank you for joining today's session. My name is David, and I work as a product manager at a small software company in Seattle. Over the next twenty minutes, I want to share three lessons we learned while moving our product from a desktop application to a mobile platform.

The first lesson is about listening to your users. When we started the project, our team believed that users wanted every desktop feature available on mobile. We spent four months building a complete feature mirror, and the result was a cluttered interface that nobody used. User testing showed that people only needed five core features on their phones. We removed everything else, and our daily active users doubled within two months.

The second lesson is about performance on older devices. Our office phones were all new flagship models, so everything felt fast to us. But when we shipped version one, we received complaints from users with phones that were three or four years old. The app took fifteen seconds to open on those devices. We had to rebuild the startup process, defer loading non-essential modules, and compress every image in the app. Startup time dropped from fifteen seconds to under three seconds, and the negative reviews stopped.

The third lesson is about offline support. We assumed everyone had unlimited data plans, but our user survey told a different story. Almost forty percent of our users were commuting on subways with no signal, and another twenty percent were traveling internationally with expensive data. We added offline mode with local storage and background sync. When the connection returns, changes upload automatically. This single feature became the most mentioned item in our five-star reviews.

Let me close with a summary. Listen to your users instead of your assumptions. Test on real devices, especially old ones. And design for offline first, because the network is never as reliable as the demo room. Thank you very much for your attention, and I am happy to take questions.
```

**記錄：**
- [ ] 耗時：____ 秒（若超過 60 秒沒反應，等到 3 分鐘再放棄，記下卡住時 UI 狀態：轉圈？按鈕鎖死？App 閃退？）
- [ ] 輸出完整度：對照原文結尾「I am happy to take questions」有沒有出現在譯文結尾
- [ ] 段落數：原文 6 段，譯文剩幾段？
- [ ] 數字抽查：twenty minutes、five core features、15→3 秒、40%、20% 有沒有正確出現
- [ ] 繁化：出來是台灣用字繁體嗎（軟體 not 軟件）？

---

## 測試 C：真實 VoiceNotes 逐字稿（最有代表性，有錄音就直接做）

1. 開 VoiceNotes，找任一「英文逐字稿」的錄音（或當場錄一段 ~3 分鐘英文）
2. 複製逐字稿全文 → 切到旅行翻譯小助手 → 貼上 → 翻譯
3. 記錄：字數（大概行數即可）、耗時、結尾是否翻完、有無閃退

---

## 結果判讀（對照表）

| 症狀 | 代表意義 | 對應修法方向 |
|---|---|---|
| A/B 都正常、換行只影響排版 | 引擎吃得下，只差段落保留 | 按段落切開分別翻譯再接回（ML Kit 官方建議做法） |
| B 變慢但翻得完 | 延遲可接受範圍內 | 同上，切段還能順便加速 |
| B 卡死/閃退/截斷 | 整段送不可行 | 必須做句級分段（社群慣例 5-10 句一段）＋進度提示 |
| 換行全消失、譯文一坨 | 已知行為，非 bug | 分段翻譯即可解 |

測完把結果（勾選＋數字）丟回來，我判讀後再決定要不要動 `translationService.ts` 加分段——動工前會先備份並走一次只修一個功能。
