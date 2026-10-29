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
    private PluginCall pendingTranscribeCall;
    private SpeechRecognizer transcribeRecognizer;
    private ParcelFileDescriptor transcribePfd;
    private boolean transcribing = false;
    // 轉檔模式的最佳 partial（引擎的 final 常是空的；partial 是同一段的持續修訂
    // ——只保留最長的一份，絕不能串接，否則同一句會被重複疊加成一坨）
    private String bestPartial = "";

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
            int bufSize = Math.max(minBuf, SAMPLE_RATE);
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize);
            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release();
                audioRecord = null;
                fos.close();
                call.reject("音訊裝置初始化失敗（可能被其他 App 佔用）");
                return;
            }

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
            call.resolve(ret);
        } catch (Exception e) {
            recording = false;
            call.reject("錄音啟動失敗：" + e.getMessage());
        }
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
     * 把錄好的 WAV 交給端側辨識器轉逐字稿。
     * 用 API 33+ 的 EXTRA_AUDIO_SOURCE（ParcelFileDescriptor）餵音檔——
     * 不需即時串流，不受段落重啟限制，全程離線。
     * 轉寫中的即時文字走 partialTranscript 事件；完成時 resolve { text }。
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
        transcribing = true;
        activity.runOnUiThread(() -> {
            try {
                File f = new File(path);
                if (!f.exists() || f.length() <= 44) {
                    failTranscribe("錄音檔是空的（可能沒收到聲音）");
                    return;
                }
                bestPartial = "";
                transcribePfd = ParcelFileDescriptor.open(
                        f, ParcelFileDescriptor.MODE_READ_ONLY);
                transcribeRecognizer = SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
                        ? SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
                        : SpeechRecognizer.createSpeechRecognizer(activity);
                transcribeRecognizer.setRecognitionListener(this);

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, transcribePfd);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING,
                        AudioFormat.ENCODING_PCM_16BIT);
                intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE);
                transcribeRecognizer.startListening(intent);

                // 逾時保險：音長 ×4 或至少 60 秒沒結果就收手
                long audioSeconds = Math.max(1, (f.length() - 44) / (2 * SAMPLE_RATE));
                long timeoutMs = Math.max(60_000L, audioSeconds * 4000L);
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    if (transcribing && pendingTranscribeCall != null) {
                        // 逾時但已累積文字 → 直接收下，不讓使用者白等
                        String acc = composeTranscribedText();
                        if (!acc.isEmpty()) {
                            finishTranscribe(acc, null);
                        } else {
                            failTranscribe("轉逐字稿逾時（引擎未回報結果）");
                        }
                    }
                }, timeoutMs);
            } catch (Exception e) {
                failTranscribe("轉逐字稿啟動失敗：" + e.getMessage());
            }
        });
    }

    private void finishTranscribe(String text, String errorMessage) {
        PluginCall call = pendingTranscribeCall;
        pendingTranscribeCall = null;
        transcribing = false;
        cleanupTranscribe();
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
            data.put("text", bestPartial);
            notifyListeners("partialTranscript", data);
            return;
        }
        emitPartial(text);
    }

    /** 轉檔模式的完整文字：引擎 final 為空時用最長的 partial */
    private String composeTranscribedText() {
        return bestPartial == null ? "" : bestPartial.trim();
    }

    @Override
    public void onResults(Bundle results) {
        String text = firstMatch(results);
        if (transcribing) {
            // 引擎的 final 常為空（音檔模式）→ 用最長的 partial
            if (text == null || text.trim().isEmpty()) {
                text = composeTranscribedText();
            }
            finishTranscribe(text, null);
            return;
        }
        emitFinal(text, manuallyStopped ? "manual-stop" : "engine-end", null);
    }

    @Override
    public void onError(int error) {
        String[] rm = describeError(error);
        if (transcribing) {
            finishTranscribe("", rm[1]);
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
