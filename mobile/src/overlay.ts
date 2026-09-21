// The floating orb, from the web layer's side.
//
// Everything real happens in OverlayService.java; this is the handle. The
// permission it needs ("Display over other apps") cannot be granted by a runtime
// dialog - Android only hands it out from a settings screen - so the flow is
// always: ask, send the user there, check again when they come back.

import { registerPlugin } from '@capacitor/core';

export interface OverlayStatus {
  permitted: boolean;
  enabled: boolean;
  opened?: boolean;
}

interface OverlayPlugin {
  status(): Promise<OverlayStatus>;
  saveConfig(options: { json: string }): Promise<void>;
  screenStatus(): Promise<{ granted: boolean }>;
  requestScreenCapture(): Promise<{ granted: boolean }>;
  captureScreen(): Promise<{ success: boolean; imageBase64?: string; error?: string }>;
  requestPermission(): Promise<OverlayStatus>;
  start(): Promise<{ enabled: boolean }>;
  stop(): Promise<{ enabled: boolean }>;
}

const Overlay = registerPlugin<OverlayPlugin>('Overlay');

// The overlay engine runs on a different origin and cannot see the app's
// localStorage, so settings are handed to it through the native side.
export async function pushOverlayConfig(settings: unknown): Promise<void> {
  try {
    await Overlay.saveConfig({ json: JSON.stringify(settings) });
  } catch {
    // Not on the phone.
  }
}

export async function screenGranted(): Promise<boolean> {
  try {
    return (await Overlay.screenStatus()).granted;
  } catch {
    return false;
  }
}

export async function requestScreenCapture(): Promise<boolean> {
  try {
    return (await Overlay.requestScreenCapture()).granted;
  } catch {
    return false;
  }
}

// The overlay's WebView belongs to the service, not to Capacitor's bridge
// activity, so `Overlay.captureScreen()` simply is not there - which is why
// asking B.E.N. what was on screen worked in the app and failed from every other
// app. The service exposes the same thing on its own `BenOverlay` bridge.
//
// The image does not come back through the call. A screenshot is a few hundred
// kilobytes of base64 and the native side pushes it into the page as a string
// literal otherwise; instead the bridge signals a request id is ready and the
// finished bytes are pulled synchronously.
const nativeBridge = () => (window as any).BenOverlay as
  | {
      hasScreenGrant?: () => boolean;
      requestScreenGrant?: () => void;
      requestCapture?: (id: string) => void;
      takeCapture?: (id: string) => string;
      takeCaptureError?: (id: string) => string;
    }
  | undefined;

const CAPTURE_TIMEOUT_MS = 8000;

function captureViaBridge(): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
  const bridge = nativeBridge();
  return new Promise((resolve) => {
    const id = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const finish = (result: { success: boolean; imageBase64?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      delete (window as any).__benCaptureDone;
      resolve(result);
    };

    (window as any).__benCaptureDone = (doneId: string, ok: boolean) => {
      if (doneId !== id) return;
      if (ok) {
        const data = bridge?.takeCapture?.(id) || '';
        finish(
          data
            ? { success: true, imageBase64: data }
            : { success: false, error: 'The screenshot was empty.' }
        );
      } else {
        finish({ success: false, error: bridge?.takeCaptureError?.(id) || 'Screen capture failed.' });
      }
    };

    try {
      bridge!.requestCapture!(id);
    } catch (err: any) {
      finish({ success: false, error: err?.message || 'Screen capture is not available here.' });
      return;
    }

    setTimeout(() => finish({ success: false, error: 'The screen did not produce a frame in time.' }), CAPTURE_TIMEOUT_MS);
  });
}

// Android drops the permission once the mirror has been idle for a while, so a
// question may arrive with no grant in hand. Asking and then giving up would
// make the answer "allow it and ask me again", which is not what the user asked
// for - they asked what is on their screen. So the consent is requested and
// waited for, and the screenshot is taken the moment it lands.
const GRANT_WAIT_MS = 20000;

async function waitForGrant(has: () => boolean): Promise<boolean> {
  const until = Date.now() + GRANT_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    if (has()) return true;
  }
  return false;
}

export async function captureScreen(): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
  const bridge = nativeBridge();
  if (bridge?.requestCapture) {
    if (bridge.hasScreenGrant && !bridge.hasScreenGrant()) {
      // Asked here rather than by sending the user into the app for a setting
      // they will not go looking for mid-sentence.
      try {
        bridge.requestScreenGrant?.();
      } catch {
        return { success: false, error: 'Screen capture is not available here.' };
      }
      const granted = await waitForGrant(() => !!bridge.hasScreenGrant?.());
      if (!granted) {
        return {
          success: false,
          error: 'Android would not allow the screenshot. Tell the user the permission was declined.'
        };
      }
    }
    return captureViaBridge();
  }

  try {
    if (!(await screenGranted())) {
      const granted = await requestScreenCapture();
      if (!granted) {
        return {
          success: false,
          error: 'Android would not allow the screenshot. Tell the user the permission was declined.'
        };
      }
    }
    return await Overlay.captureScreen();
  } catch (err: any) {
    return { success: false, error: err?.message || 'Screen capture is not available here.' };
  }
}

export async function overlayStatus(): Promise<OverlayStatus> {
  try {
    return await Overlay.status();
  } catch {
    // Running in a browser rather than on the phone.
    return { permitted: false, enabled: false };
  }
}

export async function requestOverlayPermission(): Promise<OverlayStatus> {
  try {
    return await Overlay.requestPermission();
  } catch {
    return { permitted: false, enabled: false };
  }
}

export async function startOverlay(): Promise<boolean> {
  try {
    return (await Overlay.start()).enabled;
  } catch {
    return false;
  }
}

export async function stopOverlay(): Promise<boolean> {
  try {
    await Overlay.stop();
    return false;
  } catch {
    return false;
  }
}
