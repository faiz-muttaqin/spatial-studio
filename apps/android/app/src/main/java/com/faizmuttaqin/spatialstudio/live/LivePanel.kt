package com.faizmuttaqin.spatialstudio.live

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.faizmuttaqin.spatialstudio.bridge.BridgeErrorCode
import com.faizmuttaqin.spatialstudio.security.OriginAllowlist
import kotlinx.serialization.json.put

/**
 * A small WebView over the camera view, loading `/scan/live` from the trusted origin that started the scan.
 * Its only native handle is [LiveProtocol]: open or close the preview stream. The stream is closed whenever
 * the scan screen pauses, finishes or is cancelled; the recorded bundle never depends on it.
 */
class LivePanel(
    private val parent: ViewGroup,
    private val allowlist: OriginAllowlist,
    private val origin: OriginAllowlist.Origin,
    private val stream: LiveStream,
) : WebViewCompat.WebMessageListener {
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null

    @Volatile
    private var proxy: JavaScriptReplyProxy? = null
    private var destroyed = false

    // WEB_MESSAGE_LISTENER is checked at the top of show(); the reply proxy only exists once it was.
    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    fun show(context: Context) {
        if (webView != null || destroyed) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(TAG, "WebView does not support WebMessageListener; no live preview")
            return
        }
        val view = WebView(context)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        view.setBackgroundColor(Color.TRANSPARENT)
        view.webViewClient = object : WebViewClient() {
            // The panel shows one page. Anything else is dropped, not opened in a browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !allowlist.isAllowedNavigation(request.url.toString()) || request.url.path != LIVE_PATH

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (url != null && url.startsWith("http") && !allowlist.isAllowedNavigation(url)) view.stopLoading()
            }
        }
        WebViewCompat.addWebMessageListener(view, LiveProtocol.OBJECT_NAME, setOf(origin.toString()), this)
        parent.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        view.loadUrl("$origin$LIVE_PATH")
    }

    fun hide() {
        closeStream()
        webView?.let { parent.removeView(it); it.destroy() }
        webView = null
        proxy = null
    }

    fun onPause() {
        closeStream()
        webView?.onPause()
    }

    fun onResume() {
        webView?.onResume()
        // The page reopens the stream when it sees this.
        post(LiveProtocol.event("ready"))
    }

    fun destroy() {
        destroyed = true
        hide()
    }

    /** Closes the port or socket. Idempotent. Tells the page so it stops waiting. */
    fun closeStream() {
        if (stream.isOpen) {
            stream.detach()
            post(LiveProtocol.event("closed"))
        }
    }

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (allowlist.match(sourceOrigin.toString()) != origin || !isMainFrame) return
        proxy = replyProxy
        val data = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
        when (val parsed = LiveProtocol.parse(data)) {
            is LiveProtocol.Parsed.Error -> post(LiveProtocol.error(parsed.id, parsed.code, parsed.message))
            is LiveProtocol.Parsed.Close -> {
                // The page asked, so the reply is enough; a `closed` event could overtake a later open.
                stream.detach()
                post(LiveProtocol.ok(parsed.id))
            }
            is LiveProtocol.Parsed.Open -> open(view, parsed)
        }
    }

    private fun open(view: WebView, request: LiveProtocol.Parsed.Open) {
        stream.detach()
        try {
            when (request.transport) {
                "port" -> openPort(view, request.id)
                else -> {
                    val server = LoopbackSocketServer(setOf(origin.toString()))
                    val endpoint = server.start()
                    stream.attach(server)
                    post(
                        LiveProtocol.ok(request.id) {
                            put("transport", "ws")
                            put("url", endpoint.url)
                        },
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not open the live stream", e)
            post(LiveProtocol.error(request.id, BridgeErrorCode.INTERNAL, "Could not open the stream"))
        }
    }

    @SuppressLint("RequiresFeature")
    private fun openPort(view: WebView, id: String) {
        if (!portSupported()) {
            post(LiveProtocol.error(id, BridgeErrorCode.UNSUPPORTED, "This WebView cannot send binary messages"))
            return
        }
        val ports = WebViewCompat.createWebMessageChannel(view)
        // The page end travels with the message; it is delivered only to a page on [origin].
        WebViewCompat.postWebMessage(view, WebMessageCompat(PORT_MESSAGE, arrayOf(ports[1])), Uri.parse(origin.toString()))
        stream.attach(PortTransport(ports[0], main))
        post(LiveProtocol.ok(id) { put("transport", "port") })
    }

    @SuppressLint("RequiresFeature")
    private fun post(message: String) {
        val target = proxy ?: return
        main.post { runCatching { target.postMessage(message) } }
    }

    companion object {
        private const val TAG = "SpatialStudioLive"
        const val LIVE_PATH = "/scan/live"
        const val PORT_MESSAGE = "live.port"

        fun portSupported(): Boolean = listOf(
            WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL,
            WebViewFeature.POST_WEB_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_CLOSE,
            WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
        ).all(WebViewFeature::isFeatureSupported)
    }
}
