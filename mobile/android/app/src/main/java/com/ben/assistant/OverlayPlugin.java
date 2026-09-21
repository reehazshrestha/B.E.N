package com.ben.assistant;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;

/** The web layer's handle on the floating orb. */
@CapacitorPlugin(name = "Overlay")
public class OverlayPlugin extends Plugin {

    private boolean canDrawOverlay() {
        // Granted in a system settings screen, never by a runtime dialog, so it
        // is asked about rather than requested.
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || Settings.canDrawOverlays(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("permitted", canDrawOverlay());
        result.put("enabled", OverlayService.isEnabled(getContext()));
        call.resolve(result);
    }

    /** Opens the "Display over other apps" screen. There is no other way in. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (canDrawOverlay()) {
            JSObject result = new JSObject();
            result.put("permitted", true);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject result = new JSObject();
        result.put("permitted", false);
        result.put("opened", true);
        call.resolve(result);
    }

    /** The app hands its settings over so the overlay engine can read them. */
    @PluginMethod
    public void saveConfig(PluginCall call) {
        String json = call.getString("json", "");
        getContext().getSharedPreferences(OverlayService.PREFS, Context.MODE_PRIVATE)
                .edit().putString(OverlayService.KEY_CONFIG, json).apply();
        call.resolve();
    }

    // --- Screen capture -----------------------------------------------------

    @PluginMethod
    public void screenStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", ScreenCapture.hasGrant());
        call.resolve(result);
    }

    /** Opens Android's own "start recording?" dialog. There is no other way. */
    @PluginMethod
    public void requestScreenCapture(PluginCall call) {
        if (ScreenCapture.hasGrant()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        startActivityForResult(call, ScreenCapture.permissionIntent(getContext()), "screenGrantResult");
    }

    @ActivityCallback
    private void screenGrantResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        boolean ok = result.getResultCode() == android.app.Activity.RESULT_OK && result.getData() != null;
        if (ok) ScreenCapture.setGrant(result.getResultCode(), result.getData());
        JSObject payload = new JSObject();
        payload.put("granted", ok);
        call.resolve(payload);
    }

    /** One frame, right now, as base64 JPEG. */
    @PluginMethod
    public void captureScreen(final PluginCall call) {
        // The service is what holds the projection type, so make sure it is up.
        if (!OverlayService.isRunning() && canDrawOverlay()) {
            Context context = getContext();
            Intent intent = new Intent(context, OverlayService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
        }
        ScreenCapture.grabFrame(getContext(), (base64, error) -> {
            JSObject payload = new JSObject();
            if (base64 != null) {
                payload.put("success", true);
                payload.put("imageBase64", base64);
            } else {
                payload.put("success", false);
                payload.put("error", error == null ? "Screen capture failed." : error);
            }
            call.resolve(payload);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!canDrawOverlay()) {
            call.reject("Permission to display over other apps has not been granted.");
            return;
        }
        Context context = getContext();
        OverlayService.setEnabled(context, true);
        Intent intent = new Intent(context, OverlayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);

        JSObject result = new JSObject();
        result.put("enabled", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        OverlayService.setEnabled(context, false);
        context.stopService(new Intent(context, OverlayService.class));

        JSObject result = new JSObject();
        result.put("enabled", false);
        call.resolve(result);
    }
}
