package com.nonothing.roomservice;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

/**
 * ROOMSERVICE shell for the Anbernic RG477V.
 *
 * Native gamepad bridge: Android key/motion events from the built-in controls are mapped to the
 * W3C "standard" gamepad layout and pushed into the web app via window.__rsNativePad(buttons, axes).
 * This works regardless of whether the system WebView exposes navigator.getGamepads().
 * B / BACK never quit the app: they reach the app as B (close overlay).
 */
public class MainActivity extends BridgeActivity {
    private static final int BTN_COUNT = 17;
    private final boolean[] keyState = new boolean[BTN_COUNT];
    private final float[] axes = new float[4];
    private boolean trigL = false;
    private boolean trigR = false;
    private float hatX = 0f;
    private float hatY = 0f;
    private long lastSendMs = 0;
    private String lastPayload = "";
    private boolean trailingQueued = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RoomserviceNativePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView wv = getBridge().getWebView();
        // Audio can start from gamepad input, not only touch
        wv.getSettings().setMediaPlaybackRequiresUserGesture(false);
        hideSystemUi();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    private void hideSystemUi() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    /** Android keycode -> standard gamepad button index (-1 = not a pad button). */
    private static int buttonIndex(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_BUTTON_A: return 0;
            case KeyEvent.KEYCODE_BUTTON_B: return 1;
            case KeyEvent.KEYCODE_BACK: return 1;
            case KeyEvent.KEYCODE_BUTTON_X: return 2;
            case KeyEvent.KEYCODE_BUTTON_Y: return 3;
            case KeyEvent.KEYCODE_BUTTON_L1: return 4;
            case KeyEvent.KEYCODE_BUTTON_R1: return 5;
            case KeyEvent.KEYCODE_BUTTON_L2: return 6;
            case KeyEvent.KEYCODE_BUTTON_R2: return 7;
            case KeyEvent.KEYCODE_BUTTON_SELECT: return 8;
            case KeyEvent.KEYCODE_BUTTON_START: return 9;
            case KeyEvent.KEYCODE_BUTTON_THUMBL: return 10;
            case KeyEvent.KEYCODE_BUTTON_THUMBR: return 11;
            case KeyEvent.KEYCODE_DPAD_UP: return 12;
            case KeyEvent.KEYCODE_DPAD_DOWN: return 13;
            case KeyEvent.KEYCODE_DPAD_LEFT: return 14;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return 15;
            case KeyEvent.KEYCODE_BUTTON_MODE: return 16;
            default: return -1;
        }
    }

    private static boolean fromController(InputEvent e) {
        int s = e.getSource();
        return (s & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
            || (s & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
            || (s & InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        int idx = buttonIndex(code);
        boolean isBack = code == KeyEvent.KEYCODE_BACK;
        boolean isDpad = idx >= 12 && idx <= 15;
        // D-pad keys from a real keyboard stay keyboard input; everything else from the pad is ours
        if (idx >= 0 && (isBack || !isDpad || fromController(e))) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                if (e.getRepeatCount() == 0) {
                    keyState[idx] = true;
                    send(true);
                }
            } else if (e.getAction() == KeyEvent.ACTION_UP) {
                keyState[idx] = false;
                send(true);
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent e) {
        if ((e.getSource() & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
            && e.getAction() == MotionEvent.ACTION_MOVE) {
            InputDevice dev = e.getDevice();
            axes[0] = e.getAxisValue(MotionEvent.AXIS_X);
            axes[1] = e.getAxisValue(MotionEvent.AXIS_Y);
            // Right stick: Z/RZ on most pads, RX/RY on some handhelds
            boolean useRxRy = dev != null
                && dev.getMotionRange(MotionEvent.AXIS_RX) != null
                && dev.getMotionRange(MotionEvent.AXIS_Z) == null;
            axes[2] = e.getAxisValue(useRxRy ? MotionEvent.AXIS_RX : MotionEvent.AXIS_Z);
            axes[3] = e.getAxisValue(useRxRy ? MotionEvent.AXIS_RY : MotionEvent.AXIS_RZ);
            float lt = Math.max(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE));
            float rt = Math.max(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS));
            trigL = lt > 0.5f;
            trigR = rt > 0.5f;
            hatX = e.getAxisValue(MotionEvent.AXIS_HAT_X);
            hatY = e.getAxisValue(MotionEvent.AXIS_HAT_Y);
            send(false);
            return true;
        }
        return super.dispatchGenericMotionEvent(e);
    }

    private boolean pressed(int i) {
        switch (i) {
            case 6: return keyState[6] || trigL;
            case 7: return keyState[7] || trigR;
            case 12: return keyState[12] || hatY < -0.5f;
            case 13: return keyState[13] || hatY > 0.5f;
            case 14: return keyState[14] || hatX < -0.5f;
            case 15: return keyState[15] || hatX > 0.5f;
            default: return keyState[i];
        }
    }

    /** Push state to JS. Buttons always go immediately; stick-only updates are capped at ~250 Hz. */
    private void send(boolean force) {
        long now = SystemClock.uptimeMillis();
        StringBuilder sb = new StringBuilder(160);
        sb.append("window.__rsNativePad&&window.__rsNativePad([");
        for (int i = 0; i < BTN_COUNT; i++) {
            if (i > 0) sb.append(',');
            sb.append(pressed(i) ? '1' : '0');
        }
        sb.append("],[");
        for (int i = 0; i < 4; i++) {
            if (i > 0) sb.append(',');
            sb.append(String.format(Locale.US, "%.3f", axes[i]));
        }
        sb.append("])");
        String payload = sb.toString();
        if (payload.equals(lastPayload)) return;
        if (!force && now - lastSendMs < 4) {
            // Throttled: make sure the final resting state still arrives
            WebView w = getBridge() != null ? getBridge().getWebView() : null;
            if (w != null && !trailingQueued) {
                trailingQueued = true;
                w.postDelayed(() -> {
                    trailingQueued = false;
                    send(true);
                }, 6);
            }
            return;
        }
        lastPayload = payload;
        lastSendMs = now;
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null) wv.post(() -> wv.evaluateJavascript(payload, null));
    }
}
