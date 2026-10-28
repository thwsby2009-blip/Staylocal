package com.harrytsai.offlinetranslator;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必須在 super.onCreate 之前註冊：Capacitor 在 super 裡建橋並收集插件，
        // 之後才註冊的會被靜默忽略（症狀：JS 呼叫全部 "not implemented"）
        registerPlugin(SpeechInputPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
