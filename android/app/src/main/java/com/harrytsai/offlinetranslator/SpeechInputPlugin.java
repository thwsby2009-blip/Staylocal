package com.harrytsai.offlinetranslator;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

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

    private SpeechRecognizer recognizer;
    private boolean listening = false;
    private boolean finished = true;
    private boolean manuallyStopped = false;

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        Activity activity = getActivity();
        boolean available = activity != null && SpeechRecognizer.isRecognitionAvailable(activity);
        JSObject ret = new JSObject();
        ret.put("available", available);
        call.resolve(ret);
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
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            call.reject("此裝置沒有可用的語音辨識服務");
            return;
        }

        String language = call.getString("language", "en-US");

        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
            recognizer.setRecognitionListener(this);
        }

        manuallyStopped = false;
        finished = false;
        listening = true;

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        // 零上傳的關鍵：只用離線引擎（API 23+，裝置需已下載裝置端語音辨識資料）
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);

        recognizer.startListening(intent);
        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        manuallyStopped = true;
        if (recognizer != null && listening) {
            recognizer.stopListening();
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

    private String firstMatch(Bundle bundle) {
        if (bundle == null) return "";
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
        emitPartial(firstMatch(partialResults));
    }

    @Override
    public void onResults(Bundle results) {
        emitFinal(firstMatch(results),
                manuallyStopped ? "manual-stop" : "engine-end", null);
    }

    @Override
    public void onError(int error) {
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
        emitFinal("", reason, message);
    }

    @Override
    protected void handleOnDestroy() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }
}
