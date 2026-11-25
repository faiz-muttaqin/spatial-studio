package com.faizmuttaqin.spatialstudio.live

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import com.faizmuttaqin.spatialstudio.AppConfig

/**
 * Debug-only benchmark for the P2N.3 transport spike. Loads an allowlisted page, injects a receiver that
 * measures what arrives, and feeds the real [LiveStream] with synthetic frames at the planned rates
 * (depth 5 Hz at 160 x 90 plus confidence, pose, coverage, planes).
 *
 * Add `--ei stress N` to multiply every rate by N.
 *
 * `adb shell am start -n com.faizmuttaqin.spatialstudio.debug/com.faizmuttaqin.spatialstudio.live.LiveBenchActivity
 *   --es url https://host/ --es transport port|ws --ei seconds 20 --es mixed never|always`
 *
 * Results are logged under the tag `LiveBench`.
 */
class LiveBenchActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private val main = Handler(Looper.getMainLooper())
    private var stream = LiveStream()
    private var server: LoopbackSocketServer? = null
    private var feeder: Thread? = null
    private var livePanel: LivePanel? = null

    @Volatile private var running = false
    private var started = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url")?.takeIf { AppConfig.allowlist.isAllowedNavigation(it) }
        if (url == null) {
            Log.e(TAG, "url extra missing or not on a trusted origin")
            finish()
            return
        }
        val transport = intent.getStringExtra("transport") ?: "port"
        val seconds = intent.getIntExtra("seconds", 20)
        // `--ei stress 10` runs every kind ten times as often, with the byte budget raised to match.
        val stress = intent.getIntExtra("stress", 1).coerceIn(1, 100)
        if (stress > 1) {
            stream = LiveStream(
                LiveRates(
                    LiveRates.DEFAULT_INTERVALS_NS.mapValues { it.value / stress },
                    LiveRates.DEFAULT_BYTES_PER_SECOND * stress,
                    LiveRates.DEFAULT_BURST_BYTES * stress,
                ),
            )
        }
        val mixed = if (intent.getStringExtra("mixed") == "always") WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            mixedContentMode = mixed
            allowFileAccess = false
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.message().startsWith("LIVEBENCH")) Log.i(TAG, m.message())
                return true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, finishedUrl: String?) {
                if (started) return
                started = true
                Log.i(TAG, "page loaded transport=$transport mixed=${if (mixed == WebSettings.MIXED_CONTENT_NEVER_ALLOW) "never" else "always"} url=$finishedUrl")
                begin(transport, Uri.parse(url), seconds)
            }
        }
        if (transport == "panel") {
            // The real preview page in the real panel, fed by the synthetic feeder: checks the page, its
            // worker and the open handshake end to end without a scan.
            val frame = android.widget.FrameLayout(this)
            setContentView(frame)
            val origin = AppConfig.allowlist.match(Uri.parse(url).let { "${it.scheme}://${it.authority}" }) ?: return
            livePanel = LivePanel(frame, AppConfig.allowlist, origin, stream).also { it.show(this) }
            startFeeder(seconds)
            return
        }
        setContentView(webView)
        webView.loadUrl(url)
    }

    @SuppressLint("RequiresFeature") // portSupported() checks every feature used.
    private fun begin(transport: String, uri: Uri, seconds: Int) {
        val origin = "${uri.scheme}://${uri.authority}"
        if (transport == "ws") {
            val s = LoopbackSocketServer(setOf(origin))
            val endpoint = s.start()
            server = s
            stream.attach(s)
            webView.evaluateJavascript(RECEIVER_JS + "window.__bench.ws(${quote(endpoint.url)});", null)
            startFeeder(seconds)
        } else {
            if (!LivePanel.portSupported()) {
                Log.e(TAG, "port transport unsupported on this WebView")
                finish()
                return
            }
            webView.evaluateJavascript(RECEIVER_JS + "window.__bench.port();") {
                val ports = WebViewCompat.createWebMessageChannel(webView)
                WebViewCompat.postWebMessage(webView, WebMessageCompat(LivePanel.PORT_MESSAGE, arrayOf(ports[1])), Uri.parse(origin))
                stream.attach(PortTransport(ports[0], main))
                startFeeder(seconds)
            }
        }
    }

    private fun startFeeder(seconds: Int) {
        running = true
        val t = Thread({
            val depth = ByteArray(W * H * 2) { if (it % 2 == 0) ((500 + (it / 2 % W) * 7) % 256).toByte() else 2 }
            val conf = ByteArray(W * H) { (it % 251).toByte() }
            val intrinsics = floatArrayOf(120f, 120f, 80f, 45f)
            val pose = FloatArray(16).also { it[0] = 1f; it[5] = 1f; it[10] = 1f; it[15] = 1f }
            val startNs = System.nanoTime()
            val planes = List(6) { LiveFrames.PlaneInput(LiveFrames.PlaneOrientation.VERTICAL, pose, 2f, 2.5f) }
            val endNs = System.nanoTime() + seconds * 1_000_000_000L
            var bytes = 0L
            var frames = 0
            var wantedButDropped = 0
            Thread.sleep(500)
            while (running && System.nanoTime() < endNs) {
                // The page compares its Date.now() with this stamp: one device, one clock.
                val ts = System.currentTimeMillis() * 1_000_000L
                for (type in LiveFrameType.entries) {
                    if (!stream.wants(type, ts)) continue
                    val frame = when (type) {
                        LiveFrameType.DEPTH -> LiveFrames.depth(stream.nextSeq(), ts, W, H, intrinsics, pose, depth, conf)
                        LiveFrameType.POSE -> LiveFrames.pose(stream.nextSeq(), ts, walking(startNs, pose), LiveFrames.TrackingCode.TRACKING)
                        LiveFrameType.COVERAGE -> {
                            // The covered patch grows by a row of cells a second.
                            val rows = ((System.nanoTime() - startNs) / 1_000_000_000L).toInt().coerceIn(1, 40)
                            val cells = LongArray(rows * 30) { (it % 30).toLong() shl 32 xor (it / 30).toLong() }
                            LiveFrames.coverage(stream.nextSeq(), ts, 0.25f, 0f, rows * 100 / 40, cells, cells.size)
                        }
                        LiveFrameType.PLANES -> LiveFrames.planes(stream.nextSeq(), ts, planes)
                    }
                    if (stream.submit(type, ts, frame)) {
                        bytes += frame.size
                        frames++
                    } else {
                        wantedButDropped++
                    }
                }
                Thread.sleep(10)
            }
            Log.i(TAG, "feeder done sent=$frames bytes=$bytes dropped=$wantedButDropped")
            main.post { finishRun() }
        }, "live-bench-feed")
        feeder = t
        t.start()
    }

    /** A copy of [base] moving on a circle, so the camera marker moves in the preview. */
    private fun walking(startNs: Long, base: FloatArray): FloatArray {
        val t = (System.nanoTime() - startNs) / 1e9
        return base.clone().also {
            it[12] = (3.5 + 2.0 * Math.cos(t * 0.5)).toFloat()
            it[14] = (3.0 + 1.5 * Math.sin(t * 0.5)).toFloat()
        }
    }

    private fun finishRun() {
        if (livePanel != null) { finish(); return }
        webView.evaluateJavascript("window.__bench && window.__bench.stop();", null)
        main.postDelayed({ finish() }, 800)
    }

    override fun onDestroy() {
        running = false
        livePanel?.destroy()
        stream.detach()
        server?.close()
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private companion object {
        const val TAG = "LiveBench"
        const val W = 160
        const val H = 90

        /** Receives frames, checks the header, and logs latency (page clock minus send stamp), rate and gaps. */
        const val RECEIVER_JS = """
(function(){
  if (window.__bench) return;
  var st = {frames:0, bytes:0, lat:[], gaps:0, last:-1, bad:0, first:0, lastAt:0, byType:{}};
  function onFrame(buf){
    var now = Date.now();
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 24) { st.bad++; return; }
    var d = new DataView(buf);
    if (d.getUint8(0)!==83||d.getUint8(1)!==83||d.getUint8(2)!==76||d.getUint8(3)!==49) { st.bad++; return; }
    var type = d.getUint8(4);
    var seq = d.getUint32(8, true);
    var ts = d.getUint32(12, true) + d.getInt32(16, true) * 4294967296;
    if (st.last >= 0 && seq !== st.last + 1) st.gaps += (seq - st.last - 1);
    st.last = seq;
    if (!st.first) st.first = now;
    st.lastAt = now;
    st.frames++; st.bytes += buf.byteLength;
    st.byType[type] = (st.byType[type]||0) + 1;
    st.lat.push(now - ts / 1e6);
  }
  function report(tag){
    var l = st.lat.slice().sort(function(a,b){return a-b;});
    var p = function(q){return l.length ? Math.round(l[Math.min(l.length-1, Math.floor(q*l.length))]*10)/10 : null;};
    var secs = st.lastAt > st.first ? (st.lastAt - st.first)/1000 : 0;
    console.log('LIVEBENCH ' + tag + ' ' + JSON.stringify({frames:st.frames, bytes:st.bytes, secs:secs, kbps: secs? Math.round(st.bytes/secs/1024*10)/10:0, p50:p(0.5), p95:p(0.95), max:p(0.9999), gaps:st.gaps, bad:st.bad, byType:st.byType}));
  }
  var timer = setInterval(function(){ report('tick'); }, 5000);
  window.__bench = {
    stop: function(){ clearInterval(timer); report('final'); },
    port: function(){
      window.addEventListener('message', function(e){
        if (e.data !== 'live.port' || !e.ports.length) return;
        console.log('LIVEBENCH port received origin=' + e.origin);
        e.ports[0].onmessage = function(m){ onFrame(m.data); };
      });
    },
    ws: function(url){
      var t0 = performance.now();
      var ws;
      try { ws = new WebSocket(url); } catch (err) { console.log('LIVEBENCH ws constructor threw ' + err); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = function(){ console.log('LIVEBENCH ws open after ' + Math.round(performance.now()-t0) + ' ms, page=' + location.protocol); };
      ws.onerror = function(){ console.log('LIVEBENCH ws error (blocked or refused), page=' + location.protocol); };
      ws.onclose = function(e){ console.log('LIVEBENCH ws close code=' + e.code); };
      ws.onmessage = function(m){ onFrame(m.data); };
    }
  };
})();
"""
    }
}
