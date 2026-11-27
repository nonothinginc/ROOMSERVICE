package com.nonothing.roomservice;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Process;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;

/**
 * Native audio output for the WebView engine.
 *
 * The RG477V's system WebView (Chrome 113) drops chunks between Web Audio and Android, while the
 * Web Audio render itself is clean. So the final mix is tapped inside the page (AudioWorklet),
 * shipped here as 16-bit PCM, and played by our own low-latency AudioTrack on a real-time thread.
 * A ring buffer absorbs main-thread delivery jitter; its target fill adapts after any underrun.
 */
public class NativeAudioOut {
    private static final int CH = 2;
    private final Object lock = new Object();
    private short[] ring = new short[48000 * CH]; // 1 s
    private int rHead = 0, rTail = 0, rFill = 0; // in samples (shorts)
    private int sampleRate = 48000;
    private int targetFrames = 2880; // 60 ms at 48 kHz; grows after underruns
    private volatile boolean running = false;
    private volatile boolean primed = false;
    private Thread thread;
    private AudioTrack track;
    private long underruns = 0, writes = 0, dropped = 0;

    @JavascriptInterface
    public boolean start(int rate, int targetMs) {
        stop();
        underruns = 0;
        dropped = 0;
        writes = 0;
        sampleRate = rate > 0 ? rate : 48000;
        targetFrames = Math.max(512, sampleRate * Math.max(20, targetMs) / 1000);
        synchronized (lock) {
            ring = new short[sampleRate * CH];
            rHead = rTail = rFill = 0;
            primed = false;
        }
        int minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build())
            .setAudioFormat(new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                .build())
            .setBufferSizeInBytes(Math.max(minBuf * 2, 1024 * CH * 2))
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        // Android allocates a large buffer; only use ~4 hardware bursts of it (≈21 ms at 48 kHz)
        try {
            track.setBufferSizeInFrames(Math.min(track.getBufferCapacityInFrames(), 1024));
        } catch (Exception ignored) {
        }
        track.play();
        running = true;
        thread = new Thread(this::loop, "RoomserviceAudioOut");
        thread.start();
        return true;
    }

    private void loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        final int chunkFrames = 192;
        short[] buf = new short[chunkFrames * CH];
        while (running) {
            int got;
            synchronized (lock) {
                if (!primed && rFill / CH >= targetFrames) primed = true;
                if (!primed) {
                    got = 0;
                } else {
                    // Drift control: if we are far above target, skip a few frames
                    if (rFill / CH > targetFrames * 2 + 1024) {
                        int skip = 64 * CH;
                        rTail = (rTail + skip) % ring.length;
                        rFill -= skip;
                        dropped += 64;
                    }
                    got = Math.min(buf.length, rFill);
                    for (int i = 0; i < got; i++) {
                        buf[i] = ring[rTail];
                        rTail = (rTail + 1) % ring.length;
                    }
                    rFill -= got;
                    if (got < buf.length) {
                        // Ran dry: count it, re-prime with a bigger cushion
                        underruns++;
                        primed = false;
                        targetFrames = Math.min(sampleRate / 6, targetFrames + sampleRate / 100);
                    }
                }
            }
            for (int i = got; i < buf.length; i++) buf[i] = 0;
            track.write(buf, 0, buf.length); // blocking: paces the loop at the device rate
            writes++;
        }
    }

    /** Interleaved stereo 16-bit PCM, base64-encoded (little-endian). */
    @JavascriptInterface
    public void write(String b64) {
        if (!running) return;
        byte[] bytes = Base64.decode(b64, Base64.NO_WRAP);
        int n = bytes.length / 2;
        synchronized (lock) {
            for (int i = 0; i < n; i++) {
                if (rFill >= ring.length) { // overflow: drop oldest
                    rTail = (rTail + 1) % ring.length;
                    rFill--;
                }
                ring[rHead] = (short) ((bytes[2 * i] & 0xff) | (bytes[2 * i + 1] << 8));
                rHead = (rHead + 1) % ring.length;
                rFill++;
            }
        }
    }

    @JavascriptInterface
    public void stop() {
        running = false;
        if (thread != null) {
            try {
                thread.join(200);
            } catch (InterruptedException ignored) {
            }
            thread = null;
        }
        if (track != null) {
            try {
                track.stop();
                track.release();
            } catch (Exception ignored) {
            }
            track = null;
        }
    }

    /** Buffer fill + latency for the app (record/jam compensation) and the telemetry overlay. */
    @JavascriptInterface
    public String stats() {
        try {
            JSONObject o = new JSONObject();
            synchronized (lock) {
                o.put("fillMs", 1000.0 * rFill / CH / sampleRate);
                o.put("targetMs", 1000.0 * targetFrames / sampleRate);
            }
            o.put("underruns", underruns);
            o.put("dropped", dropped);
            o.put("writes", writes);
            o.put("running", running);
            int lat = track != null ? track.getBufferSizeInFrames() : 0;
            o.put("deviceBufferMs", 1000.0 * lat / sampleRate);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
