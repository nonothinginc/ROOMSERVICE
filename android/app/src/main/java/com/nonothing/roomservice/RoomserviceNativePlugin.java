package com.nonothing.roomservice;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS bridge: window.Capacitor.Plugins.RoomserviceNative.setPlaying({ playing }) */
@CapacitorPlugin(name = "RoomserviceNative")
public class RoomserviceNativePlugin extends Plugin {
    private boolean running = false;

    @PluginMethod
    public void setPlaying(PluginCall call) {
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        Intent svc = new Intent(getContext(), PlaybackService.class);
        try {
            if (playing && !running) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(svc);
                else getContext().startService(svc);
                running = true;
            } else if (!playing && running) {
                getContext().stopService(svc);
                running = false;
            }
            JSObject ret = new JSObject();
            ret.put("running", running);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("playback service failed: " + e.getMessage());
        }
    }
}
