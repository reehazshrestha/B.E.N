package com.ben.assistant;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * One screenshot, on request.
 *
 * MediaProjection is the only way an Android app can see outside itself, and the
 * user grants it through a system dialog. Nothing is captured until something
 * calls grabFrame - this is "show me my screen when I ask", not a recorder.
 *
 * The mirror is created once and kept, which is not an optimisation. Measured on
 * Android 17: a consent token may only be turned into a MediaProjection once
 * ("Don't re-use the resultData to retrieve the same MediaProjection instance"),
 * and releasing the last VirtualDisplay stops the projection for good. Tearing
 * down after each screenshot therefore worked exactly once per permission
 * dialog, and every later question failed - which, from the outside, looked like
 * screen capture only working sometimes. So: one grant, one projection, one
 * virtual display, held until the orb is switched off or the screen has not been
 * asked about for {@link #IDLE_RELEASE_MS}.
 */
public class ScreenCapture {

    private static Intent grant;
    private static int grantCode;

    private static MediaProjection projection;
    private static VirtualDisplay display;
    private static ImageReader reader;
    private static int mirrorWidth;
    private static int mirrorHeight;

    // Android shows a recording indicator for as long as the projection lives,
    // and this is meant to feel like taking a screenshot, not like sharing the
    // screen - so the mirror is dropped again shortly after the last question.
    // Not instantly: follow-ups ("and what does that say?") come within seconds
    // and each new projection costs another system permission dialog.
    private static final long IDLE_RELEASE_MS = 45 * 1000L;
    private static final long FRAME_TIMEOUT_MS = 4000L;

    private static long lastUsedAt;
    private static FrameCallback pending;
    private static Runnable idleTimer;

    private static final Handler main = new Handler(Looper.getMainLooper());

    public interface FrameCallback {
        void onFrame(String base64Jpeg, String error);
    }

    /** Whether a screenshot can be taken without asking the user again. */
    public static boolean hasGrant() {
        return projection != null || grant != null;
    }

    public static void setGrant(int resultCode, Intent data) {
        releaseProjection();
        grantCode = resultCode;
        grant = data;
    }

    public static void clearGrant() {
        grant = null;
        releaseProjection();
    }

    public static Intent permissionIntent(Context context) {
        MediaProjectionManager manager =
                (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        return manager.createScreenCaptureIntent();
    }

    /** Called when the orb is switched off, so the recording indicator goes too. */
    public static void releaseProjection() {
        main.post(ScreenCapture::releaseNow);
    }

    private static void releaseNow() {
        if (idleTimer != null) {
            main.removeCallbacks(idleTimer);
            idleTimer = null;
        }
        // Anything still waiting for a frame will never get one now; telling it
        // so is the difference between an answer and a caller that sits there
        // until its own timeout expires.
        FrameCallback waiting = pending;
        pending = null;
        if (waiting != null) {
            waiting.onFrame(null, "Screen capture stopped before the screenshot was taken.");
        }
        VirtualDisplay oldDisplay = display;
        ImageReader oldReader = reader;
        MediaProjection oldProjection = projection;
        display = null;
        reader = null;
        projection = null;
        mirrorWidth = 0;
        mirrorHeight = 0;
        try {
            if (oldDisplay != null) oldDisplay.release();
        } catch (Throwable ignored) {
        }
        try {
            if (oldReader != null) oldReader.close();
        } catch (Throwable ignored) {
        }
        try {
            if (oldProjection != null) oldProjection.stop();
        } catch (Throwable ignored) {
        }
        if (oldProjection != null) OverlayService.releaseProjectionType();
    }

    private static void scheduleIdleRelease() {
        if (idleTimer != null) main.removeCallbacks(idleTimer);
        idleTimer = () -> {
            if (System.currentTimeMillis() - lastUsedAt >= IDLE_RELEASE_MS) releaseNow();
        };
        main.postDelayed(idleTimer, IDLE_RELEASE_MS + 1000);
    }

    /**
     * Grabs one frame of whatever is on the display right now.
     *
     * Safe to call from any thread; the callback comes back on the main thread.
     */
    public static void grabFrame(final Context context, final FrameCallback callback) {
        main.post(() -> {
            if (!hasGrant()) {
                callback.onFrame(null, "Screen capture has not been allowed yet.");
                return;
            }
            if (!OverlayService.isRunning()) {
                callback.onFrame(null,
                        "The background service is not running. Turn on the floating orb in Settings, "
                                + "which is what allows looking at the screen.");
                return;
            }
            if (!OverlayService.claimProjectionType()) {
                callback.onFrame(null, "Could not claim screen capture. Try again in a moment.");
                return;
            }
            if (pending != null) {
                callback.onFrame(null, "A screenshot is already being taken.");
                return;
            }

            try {
                ensureMirror(context);
            } catch (Throwable t) {
                // A spent consent token throws here. Nothing is recoverable
                // without asking again, so say so instead of failing silently on
                // every future request.
                clearGrant();
                callback.onFrame(null,
                        "Screen sharing needs to be allowed again - Android only lets one "
                                + "permission cover one session.");
                return;
            }

            if (display == null || reader == null) {
                clearGrant();
                callback.onFrame(null, "The screen capture permission is no longer valid.");
                return;
            }

            lastUsedAt = System.currentTimeMillis();
            scheduleIdleRelease();
            pending = callback;

            // An image may already be waiting from the mirror; if not, the
            // listener picks up the next one.
            if (!deliverLatest()) {
                main.postDelayed(() -> {
                    if (pending != callback) return;
                    if (!deliverLatest()) {
                        pending = null;
                        callback.onFrame(null, "The screen did not produce a frame in time.");
                    }
                }, FRAME_TIMEOUT_MS);
            }
        });
    }

    private static void ensureMirror(Context context) {
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        // Half resolution: enough to read a screen, a quarter of the bytes to
        // send over a phone connection.
        final int width = Math.max(480, metrics.widthPixels / 2);
        final int height = Math.max(800, metrics.heightPixels / 2);

        if (projection == null) {
            MediaProjectionManager manager = (MediaProjectionManager)
                    context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            MediaProjection fresh = manager.getMediaProjection(grantCode, (Intent) grant.clone());
            if (fresh == null) return;
            // Required before a virtual display may be made on Android 14+, and
            // also how we learn the user revoked it from the status bar.
            fresh.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    grant = null;
                    releaseNow();
                }
            }, main);
            projection = fresh;
            // The token is spent now; keeping it would only produce the re-use
            // error next time and hide the real state.
            grant = null;
        }

        // The phone was rotated, or this is the first capture.
        if (display != null && (width != mirrorWidth || height != mirrorHeight)) {
            try {
                display.release();
            } catch (Throwable ignored) {
            }
            display = null;
            try {
                if (reader != null) reader.close();
            } catch (Throwable ignored) {
            }
            reader = null;
        }

        if (display != null) return;

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(r -> {
            // Nothing is asking for a picture: drain the mirror so the producer
            // is never blocked on a full queue.
            if (pending == null) {
                Image spare = r.acquireLatestImage();
                if (spare != null) spare.close();
                return;
            }
            deliverLatest();
        }, main);

        mirrorWidth = width;
        mirrorHeight = height;
        display = projection.createVirtualDisplay(
                "ben-screen", width, height, context.getResources().getDisplayMetrics().densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(), null, main);
    }

    /** True if a frame was available and handed to the waiting caller. */
    private static boolean deliverLatest() {
        FrameCallback callback = pending;
        if (callback == null || reader == null) return false;

        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return false;

            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int rowPadding = plane.getRowStride() - plane.getPixelStride() * mirrorWidth;
            int paddedWidth = mirrorWidth + rowPadding / plane.getPixelStride();

            Bitmap bitmap = Bitmap.createBitmap(paddedWidth, mirrorHeight, Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(buffer);
            Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, mirrorWidth, mirrorHeight);

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            cropped.compress(Bitmap.CompressFormat.JPEG, 70, out);
            String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);

            bitmap.recycle();
            cropped.recycle();

            pending = null;
            callback.onFrame(base64, null);
            return true;
        } catch (Throwable t) {
            pending = null;
            callback.onFrame(null, t.getMessage());
            return true;
        } finally {
            if (image != null) image.close();
        }
    }
}
