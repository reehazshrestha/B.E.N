package com.ben.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.os.Handler;
import android.os.Looper;

/**
 * The floating orb that outlives the app.
 *
 * A foreground service, because that is the only thing on Android that keeps
 * running once the user swipes the app away. The notification it must show is
 * the price of that, and it doubles as the honest signal that B.E.N. is still
 * listening for a tap.
 *
 * Stopped only from inside the app's own settings, never by the overlay itself:
 * the user asked for something that does not disappear when the app closes, and
 * a close button on the bubble would be exactly that.
 */
public class OverlayService extends Service {

    public static final String PREFS = "ben_overlay";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_X = "x";
    public static final String KEY_Y = "y";
    public static final String KEY_CONFIG = "config";

    private static final String CHANNEL_ID = "ben_overlay";
    private static final int NOTIFICATION_ID = 4711;
    // Further than this and it was a drag, not a tap.
    private static final int TAP_SLOP_PX = 16;
    // A second tap inside this window is a double tap. A single tap has to wait
    // this long before acting, or every double tap would also start listening.
    private static final long DOUBLE_TAP_MS = 280L;
    private static final int COLLAPSED_DP = 84;
    private static final int EXPANDED_W_DP = 300;
    private static final int EXPANDED_H_DP = 190;

    private WindowManager windowManager;
    // The bubble IS the engine WebView. One view, showing the real
    // thinking-orbs canvas rather than a hand-drawn approximation of it, and
    // already running the voice session - a second WebView purely to draw a
    // circle would have been the expensive way to get a worse orb.
    private WebView bubble;
    private WindowManager.LayoutParams params;

    /**
     * The voice session runs inside a WebView the service owns, not by opening
     * the app. Tapping the orb has to start listening where the user is, and
     * throwing them into a full screen activity to do it was the opposite of
     * what a floating button is for.
     *
     * It is the same JavaScript the app runs - the Live client, the recorder,
     * the player - loaded headless. Reimplementing that pipeline in Java would
     * have been a second copy to keep correct.
     */
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean expanded = false;
    private boolean micType = false;
    // Only one of the two can hold the microphone, and a bubble floating over
    // the app it belongs to is just clutter.
    private static OverlayService instance;
    private long lastTapAt = 0;
    private Runnable pendingSingleTap = null;
    // Finished screenshots waiting to be collected by the engine, by request id.
    private final java.util.Map<String, String> captureResults =
            new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Map<String, String> captureErrors =
            new java.util.concurrent.ConcurrentHashMap<>();

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        startForegroundSafely();
        showBubble();
    }

    /**
     * Called by the activity as it comes and goes.
     *
     * Hidden while the app is open, and the overlay's own session is ended on
     * the way in: both sides use the same microphone, and whichever claimed it
     * second would have got silence. Everything said is pushed to history as it
     * happens, so the app opens showing the conversation that was in progress.
     */
    public static void setAppForeground(boolean foreground) {
        final OverlayService service = instance;
        if (service == null) return;
        service.main.post(() -> service.applyAppForeground(foreground));
    }

    private void applyAppForeground(boolean foreground) {
        if (bubble == null) return;
        if (foreground) {
            callEngine("window.__benOverlay && window.__benOverlay.stop()");
            applyExpanded(false);
            bubble.setVisibility(View.GONE);
        } else {
            bubble.setVisibility(View.VISIBLE);
        }
    }

    /** What the web layer calls back on. */
    private class Bridge {
        @JavascriptInterface
        public void setState(final String state) {
            // The orb draws its own state now; nothing to forward.
        }

        /** The popup asking to be put away again after going quiet. */
        @JavascriptInterface
        public void setExpanded(final boolean want) {
            main.post(() -> applyExpanded(want));
        }

        /**
         * The engine runs on a file:// origin and the app on Capacitor's own, so
         * they do not share localStorage. Settings travel through here instead,
         * written by the app whenever they are saved.
         */
        @JavascriptInterface
        public String getConfig() {
            return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_CONFIG, "");
        }

        // --- Screen capture ---------------------------------------------------
        //
        // The overlay cannot use the Capacitor plugin: that bridge belongs to the
        // activity, and this WebView is the service's. Without these, asking
        // B.E.N. what is on screen worked inside the app and failed everywhere
        // else - which is the one place a floating orb is for.

        @JavascriptInterface
        public boolean hasScreenGrant() {
            return ScreenCapture.hasGrant();
        }

        /** Android's own recording consent, asked for without opening the app. */
        @JavascriptInterface
        public void requestScreenGrant() {
            ScreenGrantActivity.launch(OverlayService.this);
        }

        /**
         * Starts a capture. The image does not come back through this call: a
         * base64 screenshot is a few hundred kilobytes and pushing it into
         * evaluateJavascript as a string literal is a bad way to move it. The
         * engine is told the id is ready and pulls it with takeCapture.
         */
        @JavascriptInterface
        public void requestCapture(final String id) {
            ScreenCapture.grabFrame(OverlayService.this, (base64, error) -> {
                if (base64 != null) captureResults.put(id, base64);
                else captureErrors.put(id, error == null ? "Screen capture failed." : error);
                callEngine("window.__benCaptureDone && window.__benCaptureDone("
                        + jsString(id) + "," + (base64 != null) + ")");
            });
        }

        @JavascriptInterface
        public String takeCapture(String id) {
            String value = captureResults.remove(id);
            return value == null ? "" : value;
        }

        @JavascriptInterface
        public String takeCaptureError(String id) {
            String value = captureErrors.remove(id);
            return value == null ? "" : value;
        }
    }

    private static String jsString(String raw) {
        return "'" + raw.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }

    private void callEngine(String js) {
        if (bubble == null) return;
        main.post(() -> bubble.evaluateJavascript(js, null));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Restarted by the system after being killed: come back with the bubble.
        return START_STICKY;
    }

    /**
     * Android only lets a `microphone` foreground service START while the app is
     * in the foreground. The system restarting this one in the background threw
     * SecurityException and killed the process outright - the orb vanished and
     * the log said "the app must be in the eligible state".
     *
     * So: ask for the microphone type, and if the state does not allow it, come
     * up as specialUse instead. The bubble survives either way; the microphone
     * is re-requested when the user actually taps to talk.
     */
    private void startForegroundSafely() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification);
            return;
        }
        try {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            micType = true;
        } catch (Exception e) {
            android.util.Log.w("BenOverlay", "microphone FGS refused (" + e.getMessage() + "); running without it");
            try {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } catch (Exception fallback) {
                startForeground(NOTIFICATION_ID, notification);
            }
            micType = false;
        }
    }

    /**
     * MediaProjection refuses to start unless a foreground service is already
     * running with the mediaProjection type - "Media projections require a
     * foreground service of type FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION".
     * Claimed only around a capture, so the projection indicator is not showing
     * the whole time the orb is up.
     */
    public static boolean claimProjectionType() {
        final OverlayService service = instance;
        if (service == null) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        try {
            service.startForeground(
                    NOTIFICATION_ID,
                    service.buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                            | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            return true;
        } catch (Exception e) {
            android.util.Log.w("BenOverlay", "could not claim mediaProjection type: " + e.getMessage());
            return false;
        }
    }

    /**
     * Handed back when the projection is released. Without this the service
     * keeps the mediaProjection type for the rest of its life and Android goes
     * on showing "your screen is being recorded" long after the one screenshot
     * was taken - which is exactly the impression this feature must not give.
     */
    public static void releaseProjectionType() {
        final OverlayService service = instance;
        if (service == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        service.main.post(() -> {
            try {
                service.startForeground(
                        NOTIFICATION_ID,
                        service.buildNotification(),
                        service.micType
                                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                                : ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } catch (Exception e) {
                android.util.Log.w("BenOverlay", "could not drop the mediaProjection type: " + e.getMessage());
            }
        });
    }

    public static boolean isRunning() {
        return instance != null;
    }

    /** Called when the user taps to talk, to claim the microphone type. */
    private void ensureMicType() {
        if (micType || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        try {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            micType = true;
        } catch (Exception e) {
            android.util.Log.w("BenOverlay", "could not claim the microphone type: " + e.getMessage());
        }
    }

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "B.E.N. overlay", NotificationManager.IMPORTANCE_MIN);
            channel.setDescription("Keeps the floating orb on screen.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("B.E.N.")
                .setContentText("Tap the orb to talk")
                .setSmallIcon(android.R.drawable.presence_audio_online)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    private void showBubble() {
        if (bubble != null) return;

        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);

        WebView.setWebContentsDebuggingEnabled(true);
        bubble = new WebView(this);
        WebSettings web = bubble.getSettings();
        web.setJavaScriptEnabled(true);
        web.setDomStorageEnabled(true);
        web.setMediaPlaybackRequiresUserGesture(false);
        web.setAllowFileAccess(true);
        web.setAllowFileAccessFromFileURLs(true);
        web.setAllowUniversalAccessFromFileURLs(true);
        // Transparent, so only the orb shows and not a white card behind it.
        bubble.setBackgroundColor(Color.TRANSPARENT);

        bubble.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // The app already holds RECORD_AUDIO. Without this the WebView
                // asks again through a dialog it has no window to show, and the
                // microphone silently never opens.
                main.post(() -> request.grant(request.getResources()));
            }
        });

        bubble.addJavascriptInterface(new Bridge(), "BenOverlay");
        // Capacitor's local server belongs to the bridge activity and does not
        // exist for a WebView a service owns; http:// and https://localhost both
        // gave a null origin and no bundle.
        bubble.loadUrl("file:///android_asset/public/index.html?mode=overlay");

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        int size = (int) (84 * getResources().getDisplayMetrics().density);
        params = new WindowManager.LayoutParams(
                size, size, type,
                // NOT_FOCUSABLE so the keyboard and the app underneath keep
                // working; without it the bubble swallows every key press.
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        params.gravity = Gravity.TOP | Gravity.START;
        int margin = (int) (16 * getResources().getDisplayMetrics().density);
        int defaultX = getResources().getDisplayMetrics().widthPixels - size - margin;
        // Above the dock. At 0.72 it landed on top of the home screen's icon
        // row, which is the one place on the screen people actually tap.
        int defaultY = (int) (getResources().getDisplayMetrics().heightPixels * 0.62);
        params.x = prefs.getInt(KEY_X, defaultX);
        params.y = prefs.getInt(KEY_Y, defaultY);

        bubble.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float touchX, touchY;
            private boolean dragged;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = params.x;
                        startY = params.y;
                        touchX = event.getRawX();
                        touchY = event.getRawY();
                        dragged = false;
                        return true;

                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) (event.getRawX() - touchX);
                        int dy = (int) (event.getRawY() - touchY);
                        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) dragged = true;
                        params.x = startX + dx;
                        params.y = startY + dy;
                        windowManager.updateViewLayout(bubble, params);
                        return true;

                    case MotionEvent.ACTION_UP:
                        if (dragged) {
                            // Remember where it was put; a bubble that springs
                            // back to the corner is a bubble in the way.
                            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                                    .putInt(KEY_X, params.x).putInt(KEY_Y, params.y).apply();
                            return true;
                        }

                        long now = System.currentTimeMillis();
                        if (now - lastTapAt < DOUBLE_TAP_MS) {
                            // Second tap: the single-tap action never happens.
                            if (pendingSingleTap != null) {
                                main.removeCallbacks(pendingSingleTap);
                                pendingSingleTap = null;
                            }
                            lastTapAt = 0;
                            applyExpanded(!expanded);
                        } else {
                            lastTapAt = now;
                            pendingSingleTap = () -> {
                                pendingSingleTap = null;
                                // Start or stop listening in place. The app is
                                // not opened; that is the point of the bubble.
                                ensureMicType();
                                callEngine("window.__benOverlay && window.__benOverlay.toggle()");
                            };
                            main.postDelayed(pendingSingleTap, DOUBLE_TAP_MS);
                        }
                        return true;
                }
                return false;
            }
        });

        windowManager.addView(bubble, params);
    }

    /**
     * Grows the window to fit the transcript panel and shrinks it back.
     *
     * The orb has to stay exactly where the user left it while the panel opens
     * beside it, so the window's x and y move by the same amount the window
     * grows - otherwise the orb jumps across the screen on every double tap.
     */
    private void applyExpanded(boolean want) {
        if (bubble == null || windowManager == null || want == expanded) return;
        expanded = want;

        float density = getResources().getDisplayMetrics().density;
        int collapsed = (int) (COLLAPSED_DP * density);
        int wideW = (int) (EXPANDED_W_DP * density);
        int wideH = (int) (EXPANDED_H_DP * density);

        if (want) {
            params.x -= (wideW - collapsed);
            params.y -= (wideH - collapsed);
            params.width = wideW;
            params.height = wideH;
        } else {
            params.width = collapsed;
            params.height = collapsed;
            params.x += (wideW - collapsed);
            params.y += (wideH - collapsed);
        }

        // Never off the left or top edge, however far the bubble was dragged.
        if (params.x < 0) params.x = 0;
        if (params.y < 0) params.y = 0;

        windowManager.updateViewLayout(bubble, params);
        callEngine("window.__benOverlay && window.__benOverlay.setPanel(" + want + ")");
    }

    private void openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        // Tells the web layer to open straight onto the voice screen and start
        // listening, rather than dropping the user on whatever was last shown.
        intent.putExtra("ben_start_voice", true);
        startActivity(intent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        // The kept projection is what puts "screen is being recorded" in the
        // status bar. The orb going away has to take it with it.
        ScreenCapture.releaseProjection();
        if (bubble != null) {
            if (windowManager != null) {
                try {
                    windowManager.removeView(bubble);
                } catch (Exception ignored) {
                }
            }
            bubble.destroy();
            bubble = null;
        }
        super.onDestroy();
    }
}
