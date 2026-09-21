package com.ben.assistant;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * Android's screen recording consent, asked for from the overlay.
 *
 * MediaProjection consent can only be requested by an activity, and the overlay
 * is a service - so without this, the only way to allow screen capture was to
 * open the app and find the setting, which is not something anyone is going to
 * do mid-sentence. The activity is transparent and finishes the moment the
 * system dialog is answered, so from the user's side the orb asks and they
 * answer.
 *
 * Starting an activity from a background service is normally forbidden; it is
 * allowed here because the app holds the "display over other apps" permission
 * that the orb already needs.
 */
public class ScreenGrantActivity extends Activity {

    private static final int REQUEST = 8301;

    public static void launch(Context context) {
        Intent intent = new Intent(context, ScreenGrantActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        context.startActivity(intent);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (ScreenCapture.hasGrant()) {
            finish();
            return;
        }
        try {
            startActivityForResult(ScreenCapture.permissionIntent(this), REQUEST);
        } catch (Throwable t) {
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST && resultCode == RESULT_OK && data != null) {
            ScreenCapture.setGrant(resultCode, data);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
