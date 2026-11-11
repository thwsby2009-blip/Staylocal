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
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;
import com.k2fsa.sherpa.onnx.SileroVadModelConfig;
import com.k2fsa.sherpa.onnx.SpeechSegment;
import com.k2fsa.sherpa.onnx.Vad;
import com.k2fsa.sherpa.onnx.VadModelConfig;
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

    // ===== 即時翻譯（連續收音 → VAD 句切 → SenseVoice → liveSegment 事件）=====
    // 與批次聽寫共用同一顆 SenseVoice 推論器；差別在音訊是連續進來的，
    // 句界由 Silero VAD 決定（不是等使用者按停止）。
    private static final String VAD_MODEL_URL =
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

    private Vad liveVad;
    private AudioRecord liveRecord;
    private Thread liveThread;
    private volatile boolean liveRunning = false;
    private volatile String liveLanguage = "zh";
    /** 本輪即時翻譯用的是 Whisper（非 SenseVoice 語言）還是 SenseVoice */
    private volatile boolean liveUseWhisper = false;

    private File vadModelFile() {
        return new File(svDir(), "silero_vad.onnx");
    }

    // ----- 多語引擎：Whisper（多語 int8；丹麥文等非 SenseVoice 語言走這條）-----
    // 尺寸可選：tiny 104MB（快、品質差）／base 161MB（折衷）／small 375MB（好、較慢）
    private static final String[] WHISPER_SIZES = {"tiny", "base", "small"};
    private static final String WHISPER_REPO = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-";
    private OfflineRecognizer whisperRecognizer;
    private String whisperRecognizerKey = "";
    private String liveWhisperSize = "base";

    private static boolean validWhisperSize(String size) {
        if (size == null) return false;
        for (String s : WHISPER_SIZES) {
            if (s.equals(size)) return true;
        }
        return false;
    }

    /** SenseVoice 支援的語言（其餘語言需要 Whisper） */
    private static boolean senseVoiceSupports(String language) {
        if (language == null) return false;
        switch (language) {
            case "zh":
            case "yue":
            case "en":
            case "ja":
            case "ko":
                return true;
            default:
                return false;
        }
    }

    private File whisperDir(String size) {
        return new File(getContext().getFilesDir(), "whisper-" + size);
    }

    private File whisperEncFile(String size) {
        return new File(whisperDir(size), size + "-encoder.int8.onnx");
    }

    private File whisperDecFile(String size) {
        return new File(whisperDir(size), size + "-decoder.int8.onnx");
    }

    private File whisperTokensFile(String size) {
        return new File(whisperDir(size), size + "-tokens.txt");
    }

    /** Whisper 該尺寸是否已安裝（三檔齊全且大小合理） */
    private boolean whisperInstalled(String size) {
        if (!validWhisperSize(size)) return false;
        File e = whisperEncFile(size);
        File d = whisperDecFile(size);
        File t = whisperTokensFile(size);
        return e.exists() && e.length() > 5_000_000
                && d.exists() && d.length() > 40_000_000
                && t.exists() && t.length() > 100_000;
    }

    /** 任一尺寸的多語模型是否已安裝（供 UI 判斷可否啟動） */
    private boolean anyWhisperInstalled() {
        for (String s : WHISPER_SIZES) {
            if (whisperInstalled(s)) return true;
        }
        return false;
    }

    /** 各尺寸的多語模型狀態：installed{size:bool}、sizeMb{size:MB} */
    @PluginMethod
    public void whisperModelStatus(PluginCall call) {
        JSObject installed = new JSObject();
        JSObject sizeMb = new JSObject();
        for (String s : WHISPER_SIZES) {
            installed.put(s, whisperInstalled(s));
            long bytes = 0;
            for (File f : new File[]{whisperEncFile(s), whisperDecFile(s), whisperTokensFile(s)}) {
                if (f.exists()) bytes += f.length();
            }
            sizeMb.put(s, Math.round(bytes / 1_000_000.0));
        }
        JSObject ret = new JSObject();
        ret.put("installed", installed);
        ret.put("sizeMb", sizeMb);
        ret.put("anyInstalled", anyWhisperInstalled());
        call.resolve(ret);
    }

    /** 下載指定尺寸的多語模型（tiny 104MB／base 161MB／small 375MB） */
    @PluginMethod
    public void downloadWhisperModel(PluginCall call) {
        final String size = call.getString("size", "base");
        if (!validWhisperSize(size)) {
            call.reject("未知的多語模型尺寸：" + size);
            return;
        }
        new Thread(() -> {
            try {
                File dir = whisperDir(size);
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("無法建立模型目錄");
                String base = WHISPER_REPO + size + "/resolve/main/";
                String[] files = {
                        size + "-encoder.int8.onnx",
                        size + "-decoder.int8.onnx",
                        size + "-tokens.txt",
                };
                for (String name : files) {
                    File part = new File(dir, name + ".part");
                    downloadTo(base + name, part, name);
                    File dest = new File(dir, name);
                    if (dest.exists() && !dest.delete()) throw new Exception("無法覆寫舊檔");
                    if (!part.renameTo(dest)) throw new Exception("更名失敗：" + name);
                }
                JSObject ret = new JSObject();
                ret.put("installed", whisperInstalled(size));
                ret.put("size", size);
                ret.put("sizeMb", Math.round(
                        (whisperEncFile(size).length() + whisperDecFile(size).length()
                                + whisperTokensFile(size).length()) / 1_000_000.0));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("多語模型下載失敗：" + e.getMessage());
            }
        }).start();
    }

    /** 刪除多語模型；帶 size 刪該尺寸，不帶則全刪 */
    @PluginMethod
    public void deleteWhisperModel(PluginCall call) {
        final String size = call.getString("size", "");
        releaseWhisper();
        boolean ok = true;
        String[] targets = validWhisperSize(size) ? new String[]{size} : WHISPER_SIZES;
        for (String s : targets) {
            for (File f : new File[]{whisperEncFile(s), whisperDecFile(s), whisperTokensFile(s)}) {
                if (f.exists() && !f.delete()) ok = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("deleted", ok);
        call.resolve(ret);
    }

    private void releaseWhisper() {
        if (whisperRecognizer != null) {
            try {
                whisperRecognizer.release();
            } catch (Exception ignored) {
            }
        }
        whisperRecognizer = null;
        whisperRecognizerKey = "";
    }

    /** 載入（或重用）Whisper 推論器；尺寸／語言／模型檔變了才重建 */
    private void ensureWhisper(String size, String language) throws Exception {
        File e = whisperEncFile(size);
        File d = whisperDecFile(size);
        File t = whisperTokensFile(size);
        String key = e.getAbsolutePath() + "|" + e.length() + "|" + language;
        if (whisperRecognizer != null && key.equals(whisperRecognizerKey)) return;
        releaseWhisper();

        FeatureConfig feat = new FeatureConfig();
        feat.setSampleRate(SAMPLE_RATE);
        feat.setFeatureDim(80);

        OfflineWhisperModelConfig wh = new OfflineWhisperModelConfig();
        wh.setEncoder(e.getAbsolutePath());
        wh.setDecoder(d.getAbsolutePath());
        wh.setLanguage(language);   // Whisper 語言碼（da/zh/en/ja/ko…）
        wh.setTask("transcribe");

        OfflineModelConfig mc = new OfflineModelConfig();
        mc.setWhisper(wh);
        mc.setTokens(t.getAbsolutePath());
        mc.setNumThreads(2);
        mc.setModelType("whisper");
        mc.setProvider("cpu");
        mc.setDebug(false);

        OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
        cfg.setFeatConfig(feat);
        cfg.setModelConfig(mc);
        // assetManager 一律 null（模型在檔案系統上）
        whisperRecognizer = new OfflineRecognizer(null, cfg);
        whisperRecognizerKey = key;
    }

    /**
     * 即時模式所需模型狀態：
     * VAD（約 2MB，句切）＋ SenseVoice（約 240MB，中英日韓粵）＋ Whisper（約 104MB，其他語言）
     */
    @PluginMethod
    public void liveModelStatus(PluginCall call) {
        File v = vadModelFile();
        File m = svModelFile();
        File t = svTokensFile();
        JSObject ret = new JSObject();
        ret.put("vadInstalled", v.exists() && v.length() > 100_000);
        ret.put("asrInstalled", m.exists() && m.length() > 1_000_000
                && t.exists() && t.length() > 1000);
        JSObject whisperMap = new JSObject();
        for (String s : WHISPER_SIZES) {
            whisperMap.put(s, whisperInstalled(s));
        }
        ret.put("whisperInstalled", whisperMap);
        ret.put("whisperAnyInstalled", anyWhisperInstalled());
        ret.put("vadBytes", v.exists() ? v.length() : 0);
        ret.put("dir", svDir().getAbsolutePath());
        call.resolve(ret);
    }

    /** 下載 VAD 模型（約 2MB；即時模式第一次使用時需要） */
    @PluginMethod
    public void downloadVadModel(PluginCall call) {
        new Thread(() -> {
            try {
                File dir = svDir();
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new Exception("無法建立模型目錄");
                }
                File part = new File(dir, "silero_vad.onnx.part");
                downloadTo(VAD_MODEL_URL, part, "silero_vad.onnx");
                File dest = vadModelFile();
                if (dest.exists() && !dest.delete()) {
                    throw new Exception("無法覆寫舊檔");
                }
                if (!part.renameTo(dest)) {
                    throw new Exception("更名失敗");
                }
                JSObject ret = new JSObject();
                ret.put("installed", true);
                ret.put("sizeMb", Math.round(dest.length() / 1_000_000.0));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("句切模型下載失敗：" + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void startLiveTranslation(PluginCall call) {
        if (getPermissionState(PERMISSION_ALIAS) != PermissionState.GRANTED) {
            requestAllPermissions(call, "micPermissionCallbackForLive");
            return;
        }
        beginLive(call);
    }

    @PermissionCallback
    private void micPermissionCallbackForLive(PluginCall call) {
        if (getPermissionState(PERMISSION_ALIAS) == PermissionState.GRANTED) {
            beginLive(call);
        } else {
            call.reject("麥克風權限被拒，請到系統設定開啟");
        }
    }

    private void beginLive(PluginCall call) {
        if (liveRunning) {
            call.reject("即時翻譯已在進行中");
            return;
        }
        final String language = call.getString("language", "zh");
        File v = vadModelFile();
        if (!v.exists() || v.length() < 100_000) {
            call.reject("尚未下載句切模型，請先下載");
            return;
        }
        // 語言決定用哪顆引擎：中英日韓粵走 SenseVoice，其餘走 Whisper 多語（尺寸由前端指定）
        final String whisperSize = call.getString("whisperSize", "base");
        final boolean useWhisper = !senseVoiceSupports(language);
        if (useWhisper) {
            if (!validWhisperSize(whisperSize) || !whisperInstalled(whisperSize)) {
                call.reject("「" + language + "」需要多語模型（" + whisperSize + "），請先下載");
                return;
            }
        } else if (!svModelFile().exists() || !svTokensFile().exists()) {
            call.reject("尚未下載高準度語音模型，請先下載");
            return;
        }
        try {
            if (useWhisper) {
                ensureWhisper(whisperSize, language);
                liveWhisperSize = whisperSize;
            } else {
                ensureSenseVoice(language); // 首次會載入約 240MB 模型，需數秒
            }
            liveUseWhisper = useWhisper;
        } catch (Exception e) {
            call.reject("語音模型載入失敗：" + e.getMessage());
            return;
        }
        try {
            SileroVadModelConfig svc = new SileroVadModelConfig();
            svc.setModel(v.getAbsolutePath());
            // 遠場/小聲場景（實測：60cm、最小可聞音量、有風扇底噪）門檻 0.5 抓不到 →
            // 放寬到 0.4，並把句尾靜音拉長到 0.6s（吵雜環境避免句子被切碎）
            svc.setThreshold(0.4f);
            // 1.2s 才斷句：Whisper 對「極短句 + 無上下文」最會出錯
            // （實測殘餘錯誤集中在單字級段落，如 Samot./semester），
            // 把相鄰短句併成較長片段可明顯改善
            svc.setMinSilenceDuration(1.2f);
            svc.setMinSpeechDuration(0.25f);
            // 8 秒上限：Whisper 對過長又模糊的音訊容易進入重複迴圈幻覺
            svc.setMaxSpeechDuration(8.0f);

            VadModelConfig vc = new VadModelConfig();
            vc.setSileroVadModelConfig(svc);
            vc.setSampleRate(SAMPLE_RATE);
            vc.setNumThreads(1);
            vc.setProvider("cpu");
            // assetManager 一律 null：模型在檔案系統上（同 OfflineRecognizer 的血淚教訓）
            liveVad = new Vad(null, vc);

            int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufSize = Math.max(minBuf * 2, SAMPLE_RATE);
            int src = pickAudioSource();
            liveRecord = new AudioRecord(src, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize);
            if (liveRecord.getState() != AudioRecord.STATE_INITIALIZED
                    && src != MediaRecorder.AudioSource.MIC) {
                liveRecord.release();
                src = MediaRecorder.AudioSource.MIC;
                liveRecord = new AudioRecord(src, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, bufSize);
            }
            if (liveRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                liveRecord.release();
                liveRecord = null;
                throw new Exception("音訊裝置初始化失敗（可能被其他 App 佔用）");
            }
            liveLanguage = language;
            liveGain = 1f;              // 每輪重新起算 AGC
            liveRunning = true;
            final AudioRecord rec = liveRecord;
            liveRecord.startRecording();
            liveThread = new Thread(() -> liveLoop(rec));
            liveThread.start();

            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("language", language);
            ret.put("audioSource", src); // 6=UNPROCESSED, 1=MIC
            call.resolve(ret);
        } catch (Exception e) {
            stopLiveInternal();
            call.reject("即時翻譯啟動失敗：" + e.getMessage());
        }
    }

    @PluginMethod
    public void stopLiveTranslation(PluginCall call) {
        stopLiveInternal();
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    /** 收掉即時模式（可重複呼叫、不丟例外） */
    private void stopLiveInternal() {
        liveRunning = false;
        try {
            if (liveThread != null) liveThread.join(3000);
        } catch (InterruptedException ignored) {
        }
        liveThread = null;
        try {
            if (liveRecord != null) {
                liveRecord.stop();
                liveRecord.release();
            }
        } catch (Exception ignored) {
        }
        liveRecord = null;
        if (liveVad != null) {
            try {
                liveVad.release();
            } catch (Exception ignored) {
            }
        }
        liveVad = null;
    }

    /** 目前套用的前級增益（軟體 AGC，平滑調整） */
    private float liveGain = 1f;

    /**
     * 前級軟體 AGC：把輸入拉到模型舒服的音量（目標 RMS ≈ 0.07 ≈ -23dBFS）。
     * 必須在 VAD 之前做——遠場小聲（實測 -56～-61dBFS）若只靠後級增益，
     * VAD 本身聽不到（起音偏晚 → 字首被吃掉）、模型也只拿到幾乎無聲的音訊，
     * Whisper 會開始重複迴圈幻覺。
     * 增益上限 150 倍、每 100ms 塊最多變化 1.5 倍（1 秒內可到 60 倍），避免抽吸感與瞬間爆音。
     */
    private float[] applyAgc(float[] chunk) {
        double rms = rmsOf(chunk);
        if (rms < 1e-5) return chunk;              // 全靜音不動（保留真正無聲，讓 VAD 判定）
        // 上限 150 倍：實測遠場輸入只有 -61dBFS（RMS 0.0009），依目標 0.07 需要 ~80 倍，
        // 舊上限 60 倍只能到 -25.6dBFS、且每段都頂在 60 倍（＝系統一直在增益不足狀態）。
        // 增益不足時 VAD 起音會偏晚，實際症狀是「字首音節被吃掉」
        // （實測：폭격 이후→경 이후、근데→그데、아이러니하게도→만니약）。
        float want = (float) (0.07 / rms);
        if (want > 150f) want = 150f;
        if (want < 0.5f) want = 0.5f;              // 太大聲可衰減，避免削波
        float next = liveGain;
        if (want > liveGain * 1.5f) next = liveGain * 1.5f;
        else if (want < liveGain / 1.5f) next = liveGain / 1.5f;
        else next = want;
        if (next < 0.5f) next = 0.5f;
        if (next > 150f) next = 150f;
        liveGain = next;
        float[] out = new float[chunk.length];
        for (int i = 0; i < chunk.length; i++) {
            float v = chunk[i] * liveGain;
            out[i] = v > 1f ? 1f : (v < -1f ? -1f : v);
        }
        return out;
    }

    /**
     * 判斷是否為退化輸出（Whisper 在模糊/小聲音訊上的典型幻覺）：
     * 純符號、同一句重複多次、或單一字元連續長串。
     * 這類結果不要顯示給使用者，免得看起來像「翻譯很爛」。
     */
    private static boolean looksDegenerate(String text) {
        if (text == null) return true;
        String t = text.trim();
        if (t.isEmpty()) return true;
        String letters = t.replaceAll("[\\s\\p{Punct}]+", "");
        if (letters.length() < 2) return true;                       // 只剩符號
        if (java.util.regex.Pattern.compile("(.)\\1{14,}").matcher(t).find()) return true; // 單字元×15+
        // 單一詞彙反覆（如 "i i i i i"、"næ næ næ næ"）：佔全句一半以上且出現 ≥4 次
        String[] toks = t.split("\\s+");
        if (toks.length >= 4) {
            java.util.HashMap<String, Integer> tf = new java.util.HashMap<>();
            for (String tk : toks) {
                String k = tk.replaceAll("[\\p{Punct}]", "");
                if (k.isEmpty()) continue;
                tf.put(k, tf.getOrDefault(k, 0) + 1);
            }
            for (int c : tf.values()) {
                if (c >= 4 && c * 1.0 / toks.length >= 0.5) return true;
            }
        }
        String[] parts = t.split("[.!?。！？]+");
        java.util.HashMap<String, Integer> freq = new java.util.HashMap<>();
        for (String p : parts) {
            String k = p.trim();
            if (k.length() < 4) continue;
            int c = freq.getOrDefault(k, 0) + 1;
            freq.put(k, c);
            if (c >= 4) return true;                                  // 同一句出現 4 次以上
        }
        return false;
    }

    /** 連續收音迴圈：AGC → VAD 句切 → Whisper／SenseVoice → liveSegment 事件 */
    private void liveLoop(AudioRecord rec) {
        final int frame = SAMPLE_RATE / 10; // 100ms
        short[] buf = new short[frame];
        float[] fbuf = new float[frame];
        try {
            while (liveRunning) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                for (int i = 0; i < n; i++) fbuf[i] = buf[i] / 32768.0f;
                float[] raw = (n == frame) ? fbuf : java.util.Arrays.copyOf(fbuf, n);
                liveVad.acceptWaveform(applyAgc(raw));   // 先增益再餵 VAD
                drainLiveSegments();
            }
        } catch (Exception e) {
            JSObject p = new JSObject();
            p.put("state", "error");
            p.put("message", String.valueOf(e.getMessage()));
            notifyListeners("liveStatus", p);
        }
        // 收尾：把緩衝中最後一句切出來（使用者按停止時講的那句不能漏）
        try {
            if (liveVad != null) {
                liveVad.flush();
                drainLiveSegments();
            }
        } catch (Exception ignored) {
        }
        JSObject p = new JSObject();
        p.put("state", "stopped");
        notifyListeners("liveStatus", p);
    }

    private static double rmsOf(float[] s) {
        if (s == null || s.length == 0) return 0;
        double sum = 0;
        for (float v : s) sum += (double) v * (double) v;
        return Math.sqrt(sum / s.length);
    }

    /** 取出 VAD 已切出的語段（已過前級 AGC）→ 逐句辨識 → 推事件 */
    private void drainLiveSegments() {
        while (!liveVad.empty()) {
            SpeechSegment seg = liveVad.front();
            float[] samples = seg.getSamples();
            liveVad.pop();
            if (samples == null) continue;
            if (samples.length < SAMPLE_RATE / 4) continue;                   // <0.25s 丟棄
            long t0 = System.currentTimeMillis();
            String text = "";
            final OfflineRecognizer rec = liveUseWhisper ? whisperRecognizer : svRecognizer;
            try {
                if (rec == null) throw new IllegalStateException("推論器未就緒");
                OfflineStream st = rec.createStream();
                st.acceptWaveform(samples, SAMPLE_RATE);
                rec.decode(st);
                text = rec.getResult(st).getText();
                st.release();
                // Whisper 的輸出常帶開頭的「- 」（訓練資料的段落標記），清掉
                if (text != null) text = text.replaceFirst("^[-–—\\s]+", "");
            } catch (Exception e) {
                text = "";
            }
            int ms = (int) (System.currentTimeMillis() - t0);
            if (text == null || text.trim().isEmpty()) continue;
            if (looksDegenerate(text)) {
                // 幻覺（純符號／重複迴圈）不顯示，避免看起來像「翻譯很爛」
                android.util.Log.i("SpeechInputPlugin",
                        String.format("liveSegment DROPPED(degenerate) agc=%.1f len=%d ms=%d text=%s",
                                liveGain, samples.length, ms, text.trim()));
                continue;
            }
            android.util.Log.i("SpeechInputPlugin",
                    String.format("liveSegment agc=%.1f segRms=%.4f len=%d ms=%d engine=%s text=%s",
                            liveGain, rmsOf(samples), samples.length, ms,
                            liveUseWhisper ? ("whisper-" + liveWhisperSize) : "sensevoice", text.trim()));
            JSObject p = new JSObject();
            p.put("text", text.trim());
            p.put("language", liveLanguage);
            p.put("audioMs", Math.round(samples.length * 1000.0 / SAMPLE_RATE));
            p.put("inferenceMs", ms);
            notifyListeners("liveSegment", p);
        }
    }

    @Override
    protected void handleOnDestroy() {
        // 收掉進行中的即時翻譯、錄音與轉寫
        stopLiveInternal();
        releaseWhisper();
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
