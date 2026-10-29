package com.harrytsai.offlinetranslator;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.Settings;
import android.speech.RecognitionListener;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.util.List;

import org.json.JSONArray;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * 離線語音聽寫插件：包 Android 內建 SpeechRecognizer。
 *
 * 設計重點：
 * - EXTRA_PREFER_OFFLINE=true：要求只用離線辨識引擎（零上傳的定位鐵律）
 * - start() 立即 resolve，結果走事件：
 *   - partialTranscript { text }：即時辨識中的文字
 *   - finalTranscript { text, reason, message? }：一段結束（reason:
 *     manual-stop / engine-end / no-match / error）
 * - 引擎遇停頓會自動結束一段（onResults / onError），本版不做自動重啟，
 *   由使用者再按一次錄音繼續（避免重啟縫吃字）
 */
@CapacitorPlugin(name = "SpeechInput", permissions = {
        @Permission(strings = { android.Manifest.permission.RECORD_AUDIO }, alias = "microphone")
})
public class SpeechInputPlugin extends Plugin implements RecognitionListener {

    private static final String PERMISSION_ALIAS = "microphone";
    private static final int SAMPLE_RATE = 16000;

    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private boolean finished = true;
    private boolean manuallyStopped = false;
    private boolean onDeviceMode = false;

    // ===== 批次錄音 → 轉逐字稿 =====
    private AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean recording = false;
    private File wavFile;
    private volatile long recordedBytes = 0;
    private int usedAudioSource = -1;
    private PluginCall pendingTranscribeCall;
    private SpeechRecognizer transcribeRecognizer;
    private ParcelFileDescriptor transcribePfd;
    private boolean transcribing = false;
    // 轉檔模式的最佳 partial（引擎的 final 常是空的；partial 是同一段的持續修訂
    // ——只保留最長的一份，絕不能串接，否則同一句會被重複疊加成一坨）
    private String bestPartial = "";
    // 音檔模式引擎只會轉前 ~10-15 秒 → 切成短段逐段轉再接起來
    private static final int CHUNK_SECONDS = 12;
    private final java.util.List<File> chunkFiles = new ArrayList<>();
    private int chunkIndex = -1;
    private final StringBuilder transcribeResult = new StringBuilder();
    private String transcribeLanguage = "en-US";

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        Activity activity = getActivity();
        JSObject ret = new JSObject();
        ArrayList<String> acts = new ArrayList<>();
        ArrayList<String> svcs = new ArrayList<>();
        String def = "";
        if (activity != null) {
            // 診斷是輔助資訊：任何失敗都降級為空清單，絕不可讓 App 崩潰
            try {
                ret.put("available", SpeechRecognizer.isRecognitionAvailable(activity));
                for (ResolveInfo ri : activity.getPackageManager()
                        .queryIntentActivities(new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0)) {
                    if (ri != null && ri.activityInfo != null) {
                        acts.add(ri.activityInfo.packageName);
                    }
                }
                for (ResolveInfo ri : activity.getPackageManager()
                        .queryIntentServices(new Intent("android.speech.RecognitionService"), 0)) {
                    // 查服務時 ResolveInfo 填 serviceInfo，activityInfo 是 null——必須走 serviceInfo
                    if (ri != null && ri.serviceInfo != null) {
                        svcs.add(ri.serviceInfo.packageName + "/" + ri.serviceInfo.name);
                    }
                }
                String d = Settings.Secure.getString(activity.getContentResolver(), "voice_recognition_service");
                if (d != null) def = d;
            } catch (Exception ignored) {
                // 保留已收集資料，照常回傳
            }
        }
        ret.put("speechActivities", toJsonArray(acts));
        ret.put("recognitionServices", toJsonArray(svcs));
        ret.put("defaultService", def);
        call.resolve(ret);
    }

    /** ArrayList 直接丢給 JSObject 會被序列化成字串，必須包成 JSONArray */
    private static JSONArray toJsonArray(List<String> src) {
        JSONArray arr = new JSONArray();
        if (src != null) {
            for (String s : src) {
                if (s != null) arr.put(s);
            }
        }
        return arr;
    }

    /**
     * 官方支援查詢（API 33+）：回報端側辨識的字語言狀態——
     * installed（可直接用）/ supported（要下載）/ pending（下載中）/ online。
     * 這是判斷「錯誤 13 到底是缺模型還是服務不支援」的唯一可靠來源。
     */
    @PluginMethod
    public void checkSupport(PluginCall call) {
        Activity activity = getActivity();
        JSObject ret = new JSObject();
        ret.put("onDeviceAvailable", false);
        ret.put("installedOnDeviceLanguages", new JSONArray());
        ret.put("pendingOnDeviceLanguages", new JSONArray());
        ret.put("supportedOnDeviceLanguages", new JSONArray());
        ret.put("onlineLanguages", new JSONArray());
        ret.put("error", "");
        if (activity == null) {
            call.resolve(ret);
            return;
        }
        try {
            boolean onDevice = Build.VERSION.SDK_INT >= 31
                    && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity);
            ret.put("onDeviceAvailable", onDevice);
            if (Build.VERSION.SDK_INT < 33) {
                ret.put("error", "此 Android 版本（" + Build.VERSION.SDK_INT + "）沒有支援查詢 API");
                call.resolve(ret);
                return;
            }
            final boolean useOnDevice = onDevice;
            final Intent intent = buildIntent("en-US");
            final JSObject out = ret;
            // 建立 recognizer 必須在主執行緒
            activity.runOnUiThread(() -> {
                try {
                    final SpeechRecognizer r = useOnDevice
                            ? SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
                            : SpeechRecognizer.createSpeechRecognizer(activity);
                    r.checkRecognitionSupport(intent, activity.getMainExecutor(),
                            new RecognitionSupportCallback() {
                                @Override
                                public void onSupportResult(RecognitionSupport support) {
                                    out.put("installedOnDeviceLanguages",
                                            toJsonArray(support.getInstalledOnDeviceLanguages()));
                                    out.put("pendingOnDeviceLanguages",
                                            toJsonArray(support.getPendingOnDeviceLanguages()));
                                    out.put("supportedOnDeviceLanguages",
                                            toJsonArray(support.getSupportedOnDeviceLanguages()));
                                    out.put("onlineLanguages",
                                            toJsonArray(support.getOnlineLanguages()));
                                    call.resolve(out);
                                }

                                @Override
                                public void onError(int error) {
                                    out.put("error", "支援查詢失敗（錯誤 " + error + "）");
                                    call.resolve(out);
                                }
                            });
                } catch (Exception e) {
                    out.put("error", String.valueOf(e.getMessage()));
                    call.resolve(out);
                }
            });
        } catch (Exception e) {
            ret.put("error", String.valueOf(e.getMessage()));
            call.resolve(ret);
        }
    }

    /** 觸發端側語言模型下載（API 33+，需網路） */
    @PluginMethod
    public void downloadOnDeviceModel(PluginCall call) {
        Activity activity = getActivity();
        String language = call.getString("language", "en-US");
        JSObject ret = new JSObject();
        ret.put("triggered", false);
        if (activity == null || Build.VERSION.SDK_INT < 33) {
            ret.put("message", "此裝置不支援端側模型下載");
            call.resolve(ret);
            return;
        }
        try {
            if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) {
                ret.put("message", "此裝置沒有端側辨識服務");
                call.resolve(ret);
                return;
            }
            final Intent intent = buildIntent(language);
            final JSObject out = ret;
            // 建立 recognizer 必須在主執行緒
            activity.runOnUiThread(() -> {
                try {
                    SpeechRecognizer r = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity);
                    r.triggerModelDownload(intent);
                    out.put("triggered", true);
                    out.put("message", "已觸發「" + language + "」端側語音模型下載（需網路）");
                    call.resolve(out);
                } catch (Exception e) {
                    out.put("message", "下載觸發失敗：" + e.getMessage());
                    call.resolve(out);
                }
            });
        } catch (Exception e) {
            ret.put("message", String.valueOf(e.getMessage()));
            call.resolve(ret);
        }
    }

    private static ArrayList<String> strList(List<String> src) {
        ArrayList<String> out = new ArrayList<>();
        if (src != null) {
            for (String s : src) {
                if (s != null) out.add(s);
            }
        }
        return out;
    }

    private static Intent buildIntent(String language) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        return intent;
    }

    // ===== 批次架構：先錄音成 WAV，停止後再轉逐字稿 =====

    /** 開始錄音（16kHz 單聲道 PCM16 → WAV，存 app 快取目錄） */
    @PluginMethod
    public void startRecording(PluginCall call) {
        if (getPermissionState(PERMISSION_ALIAS) != PermissionState.GRANTED) {
            requestAllPermissions(call, "micPermissionCallbackForRecording");
            return;
        }
        beginRecording(call);
    }

    @PermissionCallback
    private void micPermissionCallbackForRecording(PluginCall call) {
        if (getPermissionState(PERMISSION_ALIAS) == PermissionState.GRANTED) {
            beginRecording(call);
        } else {
            call.reject("麥克風權限被拒，請到系統設定開啟");
        }
    }

    private void beginRecording(PluginCall call) {
        if (recording) {
            call.reject("已在錄音中");
            return;
        }
        Context ctx = getContext();
        try {
            wavFile = new File(ctx.getCacheDir(), "dictation.wav");
            FileOutputStream fos = new FileOutputStream(wavFile);
            fos.write(wavHeader(0)); // 先寫 44 byte 表頭，停止時回填大小

            int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufSize = Math.max(minBuf * 2, SAMPLE_RATE * 2);
            // 用「原始收音」：VOICE_RECOGNITION 會被套上 Google 專屬降噪/AGC 處理，
            // 那條處理鏈的聲音只有 Google 自家引擎聽得懂，離線模型（SenseVoice/
            // Paraformer）會聽成雜訊。UNPROCESSED 是未處理的原始麥克風訊號。
            int src = pickAudioSource();
            audioRecord = new AudioRecord(src,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize);
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED
                    && src != MediaRecorder.AudioSource.MIC) {
                audioRecord.release();
                src = MediaRecorder.AudioSource.MIC;
                audioRecord = new AudioRecord(src, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, bufSize);
            }
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release();
                audioRecord = null;
                fos.close();
                call.reject("音訊裝置初始化失敗（可能被其他 App 佔用）");
                return;
            }
            usedAudioSource = src;

            recordedBytes = 0;
            recording = true;
            audioRecord.startRecording();

            final FileOutputStream out = fos;
            final AudioRecord rec = audioRecord;
            recordThread = new Thread(() -> {
                byte[] buf = new byte[4096];
                try {
                    while (recording) {
                        int n = rec.read(buf, 0, buf.length);
                        if (n > 0) {
                            out.write(buf, 0, n);
                            recordedBytes += n;
                        }
                    }
                    out.flush();
                    out.close();
                } catch (Exception ignored) {
                }
            });
            recordThread.start();

            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("path", wavFile.getAbsolutePath());
            ret.put("audioSource", usedAudioSource); // 6=UNPROCESSED, 1=MIC, 7=VOICE_RECOGNITION
            call.resolve(ret);
        } catch (Exception e) {
            recording = false;
            call.reject("錄音啟動失敗：" + e.getMessage());
        }
    }

    // ===== SenseVoice（sherpa-onnx）高準度離線模型：選用加強 =====
    // Google 端側引擎品質有限且無標點；安裝 SenseVoice 後改用 sherpa-onnx 推論。
    // 模型（239MB）首次使用時下載，不進 APK、不進版控（授權：FunASR Model License v1.1）。

    private static final String SV_MODEL_URL = "https://huggingface.co/csukuangfj/"
            + "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx";
    private static final String SV_TOKENS_URL = "https://huggingface.co/csukuangfj/"
            + "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt";
    private static final int SV_SEGMENT_SECONDS = 25;

    private OfflineRecognizer svRecognizer;
    private String svRecognizerKey = "";
    private volatile boolean svDownloading = false;

    private File svDir() {
        return new File(getContext().getFilesDir(), "sense-voice");
    }

    private File svModelFile() {
        return new File(svDir(), "model.int8.onnx");
    }

    private File svTokensFile() {
        return new File(svDir(), "tokens.txt");
    }

    /** 模型是否已安裝（檔案大小做基本驗證，避免下載中斷的半成品） */
    @PluginMethod
    public void asrModelStatus(PluginCall call) {
        File m = svModelFile();
        File t = svTokensFile();
        boolean installed = m.exists() && m.length() > 1_000_000
                && t.exists() && t.length() > 1000;
        JSObject ret = new JSObject();
        ret.put("installed", installed);
        ret.put("modelBytes", m.exists() ? m.length() : 0);
        // 用十進位 MB（與卡片上的「約 240MB」一致；1,048,576 進位會顯示成 228 造成不一致）
        ret.put("sizeMb", Math.round((m.exists() ? m.length() : 0) / 1_000_000.0));
        ret.put("dir", svDir().getAbsolutePath());
        call.resolve(ret);
    }

    /** 下載模型（背景執行；進度走 asrDownloadProgress 事件） */
    @PluginMethod
    public void downloadAsrModel(PluginCall call) {
        if (svDownloading) {
            call.reject("模型下載中，請稍候");
            return;
        }
        final String modelUrl = call.getString("modelUrl", SV_MODEL_URL);
        final String tokensUrl = call.getString("tokensUrl", SV_TOKENS_URL);
        svDownloading = true;
        new Thread(() -> {
            try {
                File dir = svDir();
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new Exception("無法建立模型目錄");
                }
                File modelPart = new File(dir, "model.int8.onnx.part");
                File tokensPart = new File(dir, "tokens.txt.part");
                downloadTo(modelUrl, modelPart, "model.int8.onnx");
                downloadTo(tokensUrl, tokensPart, "tokens.txt");
                // 先存成 .part，兩個檔都完整才轉正式檔名（避免半成品被當成已安裝）
                File model = svModelFile();
                File tokens = svTokensFile();
                if (model.exists()) model.delete();
                if (tokens.exists()) tokens.delete();
                if (!modelPart.renameTo(model)) throw new Exception("模型檔更名失敗");
                if (!tokensPart.renameTo(tokens)) throw new Exception("詞表檔更名失敗");
                svDownloading = false;
                JSObject ret = new JSObject();
                ret.put("installed", true);
                ret.put("sizeMb", Math.round(model.length() / 1_000_000.0));
                call.resolve(ret);
            } catch (Exception e) {
                svDownloading = false;
                call.reject("模型下載失敗：" + e.getMessage());
            }
        }).start();
    }

    private void downloadTo(String url, File dest, String label) throws Exception {
        java.net.HttpURLConnection conn =
                (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        conn.connect();
        int code = conn.getResponseCode();
        if (code != 200) throw new Exception("HTTP " + code + "（" + label + "）");
        long total = conn.getContentLengthLong();
        java.io.InputStream in = conn.getInputStream();
        FileOutputStream out = new FileOutputStream(dest);
        byte[] buf = new byte[64 * 1024];
        long got = 0;
        long lastEmit = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            got += n;
            long now = System.currentTimeMillis();
            if (now - lastEmit > 400) {
                lastEmit = now;
                JSObject p = new JSObject();
                p.put("file", label);
                p.put("received", got);
                p.put("total", total);
                p.put("percent", total > 0 ? (int) Math.round(got * 100.0 / total) : -1);
                notifyListeners("asrDownloadProgress", p);
            }
        }
        out.flush();
        out.close();
        in.close();
        if (total > 0 && got != total) {
            throw new Exception("下載不完整（" + got + "/" + total + "）");
        }
    }

    /** 刪除模型（釋放空間） */
    @PluginMethod
    public void deleteAsrModel(PluginCall call) {
        releaseSenseVoice();
        File m = svModelFile();
        File t = svTokensFile();
        boolean a = !m.exists() || m.delete();
        boolean b = !t.exists() || t.delete();
        JSObject ret = new JSObject();
        ret.put("deleted", a && b);
        call.resolve(ret);
    }

    /**
     * 用 SenseVoice 轉寫整段錄音（離線，含標點）。
     * 長錄音切 SV_SEGMENT_SECONDS 秒逐段推論再接起來（非自迴歸模型分段較穩、記憶體可控）。
     * 進度走 partialTranscript 事件。
     */
    @PluginMethod
    public void transcribeWithSenseVoice(PluginCall call) {
        final String path = call.getString("path", "");
        final String language = call.getString("language", "zh");
        if (path == null || path.isEmpty()) {
            call.reject("缺少音檔路徑");
            return;
        }
        if (!svModelFile().exists() || !svTokensFile().exists()) {
            call.reject("尚未下載高準度語音模型");
            return;
        }
        new Thread(() -> {
            try {
                ensureSenseVoice(language);
                float[] samples = readWavSamples(new File(path));
                if (samples.length == 0) {
                    throw new Exception("音檔是空的（可能沒收到聲音）");
                }
                final int segSamples = SV_SEGMENT_SECONDS * SAMPLE_RATE;
                StringBuilder sb = new StringBuilder();
                for (int off = 0; off < samples.length; off += segSamples) {
                    int len = Math.min(segSamples, samples.length - off);
                    float[] chunk = java.util.Arrays.copyOfRange(samples, off, off + len);
                    OfflineStream stream = svRecognizer.createStream();
                    stream.acceptWaveform(chunk, SAMPLE_RATE);
                    svRecognizer.decode(stream);
                    String text = svRecognizer.getResult(stream).getText();
                    stream.release();
                    if (text != null && !text.trim().isEmpty()) {
                        if (sb.length() > 0) sb.append('\n');
                        sb.append(text.trim());
                    }
                    JSObject p = new JSObject();
                    p.put("text", sb.toString());
                    notifyListeners("partialTranscript", p);
                }
                JSObject ret = new JSObject();
                ret.put("text", sb.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("語音模型轉寫失敗：" + e.getMessage());
            }
        }).start();
    }

    /** 載入（或重用）SenseVoice 推論器；語言不同或模型換了才重建 */
    private void ensureSenseVoice(String language) throws Exception {
        File m = svModelFile();
        File t = svTokensFile();
        String key = m.getAbsolutePath() + "|" + m.length() + "|" + language;
        if (svRecognizer != null && key.equals(svRecognizerKey)) return;
        releaseSenseVoice();

        FeatureConfig feat = new FeatureConfig();
        feat.setSampleRate(SAMPLE_RATE);
        feat.setFeatureDim(80);

        OfflineSenseVoiceModelConfig sv = new OfflineSenseVoiceModelConfig();
        sv.setModel(m.getAbsolutePath());
        sv.setLanguage(language);
        sv.setUseInverseTextNormalization(true); // 口語數字轉阿拉伯數字等

        OfflineModelConfig mc = new OfflineModelConfig();
        mc.setSenseVoice(sv);
        mc.setTokens(t.getAbsolutePath());
        mc.setNumThreads(2);
        mc.setModelType("sense-voice");
        mc.setProvider("cpu");
        mc.setDebug(false);

        OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
        cfg.setFeatConfig(feat);
        cfg.setModelConfig(mc);
        // assetManager 必須傳 null：模型是檔案系統上的絕對路徑（使用者裝置端下載的），
        // 傳 Assets 會讓 sherpa-onnx 走 AssetManager 讀檔失敗並 LOG(FATAL) 直接中斷行程
        // （native abort，Java 攔不到，症狀＝按停止錄音就閃退、crash buffer 卻是空的）。
        svRecognizer = new OfflineRecognizer(null, cfg);
        svRecognizerKey = key;
    }

    private void releaseSenseVoice() {
        if (svRecognizer != null) {
            try {
                svRecognizer.release();
            } catch (Exception ignored) {
            }
        }
        svRecognizer = null;
        svRecognizerKey = "";
    }

    /** 讀我們自己寫的 44-byte 表頭 WAV → 16kHz float 樣本 */
    private float[] readWavSamples(File f) throws Exception {
        byte[] all = new byte[(int) f.length()];
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        int read = readFully(in, all, all.length);
        in.close();
        if (read <= 44) return new float[0];
        int n = (read - 44) / 2;
        float[] out = new float[n];
        for (int i = 0; i < n; i++) {
            int lo = all[44 + 2 * i] & 0xff;
            int hi = all[44 + 2 * i + 1];
            out[i] = (short) ((hi << 8) | lo) / 32768.0f;
        }
        return out;
    }

    /** 選收音來源：優先「原始未處理」收音，裝置不支援才退回 MIC */
    private int pickAudioSource() {
        try {
            android.media.AudioManager am = (android.media.AudioManager)
                    getContext().getSystemService(Context.AUDIO_SERVICE);
            String supported = am == null ? null : am.getProperty(
                    android.media.AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED);
            if ("true".equals(supported)) {
                return MediaRecorder.AudioSource.UNPROCESSED;
            }
        } catch (Exception ignored) {
        }
        return MediaRecorder.AudioSource.MIC;
    }

    /** 停止錄音：補 WAV 表頭，回傳路徑/秒數 */
    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (!recording) {
            call.reject("沒有進行中的錄音");
            return;
        }
        recording = false;
        try {
            if (recordThread != null) recordThread.join(2000);
        } catch (InterruptedException ignored) {
        }
        recordThread = null;
        try {
            if (audioRecord != null) {
                audioRecord.stop();
                audioRecord.release();
                audioRecord = null;
            }
        } catch (Exception ignored) {
        }
        try {
            RandomAccessFile raf = new RandomAccessFile(wavFile, "rw");
            raf.seek(0);
            raf.write(wavHeader((int) recordedBytes));
            raf.setLength(44 + recordedBytes); // 截掉表頭宣告之外的殘留位元組
            raf.close();
        } catch (Exception ignored) {
        }

        JSObject ret = new JSObject();
        ret.put("path", wavFile == null ? "" : wavFile.getAbsolutePath());
        ret.put("bytes", recordedBytes);
        ret.put("seconds", recordedBytes / (2.0 * SAMPLE_RATE));
        call.resolve(ret);
    }

    /**
     * 把錄好的 WAV 交給端側辨識器轉逐字稿（批次、全程離線）。
     * 關鍵：引擎對音檔只會轉前面約 10-15 秒 → 先把音檔切成 CHUNK_SECONDS 秒的短段，
     * 逐段餵給辨識器再把文字接起來（每段短，準度也較好）。
     * 進度走 partialTranscript 事件；全部完成後 resolve { text }。
     */
    @PluginMethod
    public void transcribeFile(PluginCall call) {
        Activity activity = getActivity();
        final String path = call.getString("path",
                wavFile == null ? "" : wavFile.getAbsolutePath());
        final String language = call.getString("language", "en-US");
        if (activity == null || path == null || path.isEmpty()) {
            call.reject("缺少音檔路徑");
            return;
        }
        if (Build.VERSION.SDK_INT < 33) {
            call.reject("此 Android 版本不支援音檔轉逐字稿（需 Android 13+）");
            return;
        }
        if (transcribing) {
            call.reject("已在轉逐字稿中");
            return;
        }
        pendingTranscribeCall = call;
        transcribeLanguage = language;
        transcribing = true;
        activity.runOnUiThread(() -> {
            try {
                File f = new File(path);
                if (!f.exists() || f.length() <= 44) {
                    failTranscribe("錄音檔是空的（可能沒收到聲音）");
                    return;
                }
                bestPartial = "";
                transcribeResult.setLength(0);
                chunkIndex = -1;
                chunkFiles.clear();

                // 切段（跳過 44 byte 表頭）
                final int chunkBytes = CHUNK_SECONDS * SAMPLE_RATE * 2;
                java.io.FileInputStream in = new java.io.FileInputStream(f);
                in.skip(44);
                byte[] buf = new byte[chunkBytes];
                int idx = 0;
                while (true) {
                    int read = readFully(in, buf, chunkBytes);
                    if (read <= 0) break;
                    File cf = new File(getContext().getCacheDir(), "chunk_" + idx + ".wav");
                    FileOutputStream out = new FileOutputStream(cf);
                    out.write(wavHeader(read));
                    out.write(buf, 0, read);
                    out.close();
                    chunkFiles.add(cf);
                    idx++;
                    if (read < chunkBytes) break;
                }
                in.close();
                if (chunkFiles.isEmpty()) {
                    failTranscribe("錄音檔是空的（可能沒收到聲音）");
                    return;
                }
                startChunk(0);
            } catch (Exception e) {
                failTranscribe("轉逐字稿啟動失敗：" + e.getMessage());
            }
        });
    }

    /** 轉寫某一段（每段用全新的 recognizer + 該段音檔） */
    private void startChunk(int index) {
        Activity activity = getActivity();
        if (activity == null) {
            failTranscribe("Activity 不可用");
            return;
        }
        cleanupTranscribe(); // 清掉前一段的 recognizer / PFD
        if (index < 0 || index >= chunkFiles.size()) {
            finishTranscribe(transcribeResult.toString().trim(), null);
            return;
        }
        chunkIndex = index;
        bestPartial = "";
        try {
            transcribePfd = ParcelFileDescriptor.open(
                    chunkFiles.get(index), ParcelFileDescriptor.MODE_READ_ONLY);
            transcribeRecognizer = SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
                    ? SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
                    : SpeechRecognizer.createSpeechRecognizer(activity);
            transcribeRecognizer.setRecognitionListener(this);

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, transcribeLanguage);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, transcribePfd);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,
                    AudioFormat.ENCODING_PCM_16BIT);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE);
            transcribeRecognizer.startListening(intent);

            // 每段逾時 30 秒（單段只有 12 秒音訊，正常 1-3 秒就回）
            final int startedIndex = index;
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (transcribing && pendingTranscribeCall != null && chunkIndex == startedIndex) {
                    appendChunkText();
                    startChunk(startedIndex + 1);
                }
            }, 30_000L);
        } catch (Exception e) {
            failTranscribe("轉逐字稿啟動失敗：" + e.getMessage());
        }
    }

    /** 把當前段的最佳 partial 收進總結果 */
    private void appendChunkText() {
        String t = bestPartial == null ? "" : bestPartial.trim();
        if (!t.isEmpty()) {
            if (transcribeResult.length() > 0) transcribeResult.append('\n');
            transcribeResult.append(t);
        }
    }

    /** 目前顯示用文字：已完成段落 + 當前段 */
    private String currentShownText() {
        String acc = transcribeResult.toString().trim();
        String cur = bestPartial == null ? "" : bestPartial.trim();
        if (acc.isEmpty()) return cur;
        if (cur.isEmpty()) return acc;
        return acc + "\n" + cur;
    }

    private static int readFully(java.io.FileInputStream in, byte[] buf, int len)
            throws Exception {
        int total = 0;
        while (total < len) {
            int n = in.read(buf, total, len - total);
            if (n < 0) break;
            total += n;
        }
        return total;
    }

    private void finishTranscribe(String text, String errorMessage) {
        PluginCall call = pendingTranscribeCall;
        pendingTranscribeCall = null;
        transcribing = false;
        chunkIndex = -1;
        cleanupTranscribe();
        for (File cf : chunkFiles) {
            try {
                cf.delete();
            } catch (Exception ignored) {
            }
        }
        chunkFiles.clear();
        if (call == null) return;
        if (errorMessage != null) {
            call.reject(errorMessage);
        } else {
            JSObject ret = new JSObject();
            ret.put("text", text == null ? "" : text);
            call.resolve(ret);
        }
    }

    private void failTranscribe(String message) {
        finishTranscribe("", message);
    }

    private void cleanupTranscribe() {
        if (transcribeRecognizer != null) {
            try {
                transcribeRecognizer.destroy();
            } catch (Exception ignored) {
            }
            transcribeRecognizer = null;
        }
        if (transcribePfd != null) {
            try {
                transcribePfd.close();
            } catch (Exception ignored) {
            }
            transcribePfd = null;
        }
    }

    /** 16kHz 單聲道 16-bit PCM 的 44 byte WAV 表頭 */
    private static byte[] wavHeader(int dataSize) {
        byte[] h = new byte[44];
        int byteRate = SAMPLE_RATE * 2;
        h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F';
        putIntLE(h, 4, 36 + dataSize);
        h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E';
        h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
        putIntLE(h, 16, 16);      // fmt chunk size
        putShortLE(h, 20, 1);     // PCM
        putShortLE(h, 22, 1);     // mono
        putIntLE(h, 24, SAMPLE_RATE);
        putIntLE(h, 28, byteRate);
        putShortLE(h, 32, 2);     // block align
        putShortLE(h, 34, 16);    // bits per sample
        h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a';
        putIntLE(h, 40, dataSize);
        return h;
    }

    private static void putIntLE(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
        b[off + 2] = (byte) ((v >> 16) & 0xff);
        b[off + 3] = (byte) ((v >> 24) & 0xff);
    }

    private static void putShortLE(byte[] b, int off, int v) {
        b[off] = (byte) (v & 0xff);
        b[off + 1] = (byte) ((v >> 8) & 0xff);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (listening) {
            call.reject("已在錄音中");
            return;
        }
        if (getPermissionState(PERMISSION_ALIAS) != PermissionState.GRANTED) {
            requestAllPermissions(call, "micPermissionCallback");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState(PERMISSION_ALIAS) == PermissionState.GRANTED) {
            beginListening(call);
        } else {
            call.reject("麥克風權限被拒，請到系統設定開啟");
        }
    }

    private void beginListening(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity 不可用");
            return;
        }
        // SpeechRecognizer 規定只能在主執行緒使用——
        // Capacitor 插件方法跑在 CapacitorPlugins 背景執行緒，必須投遞到 main thread
        final PluginCall pending = call;
        final Activity act = activity;
        act.runOnUiThread(() -> runOnMainThread(pending, act));
    }

    private void runOnMainThread(PluginCall call, Activity activity) {
        try {
            if (recognizer == null) {
                // 優先用 API 31+ 的專用端側辨識器：天生離線、不走語言支援檢查
                //（標準辨識器 + EXTRA_PREFER_OFFLINE 在 Android 13+ 會回錯誤 13 CANNOT_CHECK_SUPPORT）
                onDeviceMode = Build.VERSION.SDK_INT >= 31
                        && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity);
                if (onDeviceMode) {
                    recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity);
                } else {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
                }
                recognizer.setRecognitionListener(this);
            }

            // 不在此處用 isRecognitionAvailable 擋（OEM 判定不一）——
            // 直接嘗試，服務真的不存在時 onError 會回報

            String language = call.getString("language", "en-US");

            manuallyStopped = false;
            finished = false;
            listening = true;

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
            if (!onDeviceMode) {
                // 傳統辨識器才需要聲明離線；端側辨識器天生離線
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            }
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);

            recognizer.startListening(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            listening = false;
            call.reject("語音辨識啟動失敗：" + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        manuallyStopped = true;
        Activity activity = getActivity();
        if (activity != null && recognizer != null && listening) {
            // recognizer 只能在主執行緒操作（同 start）
            activity.runOnUiThread(() -> {
                if (recognizer != null) {
                    try {
                        recognizer.stopListening();
                    } catch (Exception ignored) {
                    }
                }
            });
        }
        call.resolve();
    }

    private void emitPartial(String text) {
        if (finished || text == null || text.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("text", text);
        notifyListeners("partialTranscript", data);
    }

    private void emitFinal(String text, String reason, String message) {
        if (finished) return;
        finished = true;
        listening = false;
        JSObject data = new JSObject();
        data.put("text", text == null ? "" : text);
        data.put("reason", reason);
        if (message != null) data.put("message", message);
        notifyListeners("finalTranscript", data);
    }

    /**
     * 取第一筆辨識結果。不同引擎/模式可能放 ArrayList&lt;String&gt;、String[] 或 String，
     * 全部容忍（轉檔模式實測只看得到 partial、final 為空）。
     */
    private String firstMatch(Bundle bundle) {
        if (bundle == null) return "";
        Object raw = bundle.get(SpeechRecognizer.RESULTS_RECOGNITION);
        if (raw instanceof String) {
            return (String) raw;
        }
        if (raw instanceof String[]) {
            String[] arr = (String[]) raw;
            return arr.length > 0 ? arr[0] : "";
        }
        if (raw instanceof ArrayList) {
            ArrayList<?> list = (ArrayList<?>) raw;
            return list.isEmpty() || list.get(0) == null ? "" : String.valueOf(list.get(0));
        }
        ArrayList<String> matches =
                bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return "";
        return matches.get(0);
    }

    // ===== RecognitionListener =====

    @Override
    public void onReadyForSpeech(Bundle params) {
    }

    @Override
    public void onBeginningOfSpeech() {
    }

    @Override
    public void onRmsChanged(float rmsdB) {
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
    }

    @Override
    public void onEndOfSpeech() {
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        String text = firstMatch(partialResults);
        if (transcribing) {
            // 轉檔模式：partial 是同一份逐字稿的修訂版 → 只取最長的一份
            if (text != null && text.trim().length() > bestPartial.length()) {
                bestPartial = text.trim();
            }
            JSObject data = new JSObject();
            data.put("text", currentShownText());
            notifyListeners("partialTranscript", data);
            return;
        }
        emitPartial(text);
    }

    @Override
    public void onResults(Bundle results) {
        String text = firstMatch(results);
        if (transcribing) {
            // final 常為空（音檔模式）→ 用本段最長的 partial，收下後換下一段
            if (text != null && text.trim().length() > bestPartial.length()) {
                bestPartial = text.trim();
            }
            appendChunkText();
            startChunk(chunkIndex + 1);
            return;
        }
        emitFinal(text, manuallyStopped ? "manual-stop" : "engine-end", null);
    }

    @Override
    public void onError(int error) {
        String[] rm = describeError(error);
        if (transcribing) {
            // 本段失敗：收下已有文字、繼續下一段；最後一段才決定成功或失敗
            appendChunkText();
            if (chunkIndex + 1 < chunkFiles.size()) {
                startChunk(chunkIndex + 1);
            } else if (transcribeResult.toString().trim().isEmpty()) {
                finishTranscribe("", rm[1]);
            } else {
                finishTranscribe(transcribeResult.toString().trim(), null);
            }
            return;
        }
        emitFinal("", rm[0], rm[1]);
    }

    /** 錯誤碼 → {reason, 使用者可讀訊息} */
    private static String[] describeError(int error) {
        String reason;
        String message;
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                reason = "no-match";
                message = "沒有聽到可辨識的語音";
                break;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                reason = "error";
                message = "麥克風權限不足";
                break;
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                reason = "error";
                message = "離線辨識失敗：裝置可能尚未下載「裝置端語音辨識」資料（需在 WiFi 環境下載）";
                break;
            case 13: // ERROR_CANNOT_CHECK_SUPPORT（API 34+ 常數，舊 SDK 編譯用數字）
                reason = "error";
                message = "語音服務無法確認離線語言支援（代碼 13）：此裝置可能沒有「裝置端語音辨識」資料，請在 WiFi 下到 系統設定 → Google → 裝置端語音辨識 下載";
                break;
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                reason = "error";
                message = "辨識服務忙線中，請稍後再試";
                break;
            case SpeechRecognizer.ERROR_CLIENT:
                reason = "error";
                message = "辨識服務用戶端錯誤";
                break;
            default:
                reason = "error";
                message = "辨識錯誤（代碼 " + error + "）";
                break;
        }
        return new String[] { reason, message };
    }

    @Override
    protected void handleOnDestroy() {
        // 收掉進行中的錄音與轉寫
        recording = false;
        try {
            if (audioRecord != null) {
                audioRecord.stop();
                audioRecord.release();
                audioRecord = null;
            }
        } catch (Exception ignored) {
        }
        cleanupTranscribe();
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }
}
