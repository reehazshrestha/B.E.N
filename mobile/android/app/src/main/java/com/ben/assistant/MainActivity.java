package com.ben.assistant;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(OverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        // The bubble hides while the app is open, and hands the microphone back.
        OverlayService.setAppForeground(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        OverlayService.setAppForeground(false);
    }
}
