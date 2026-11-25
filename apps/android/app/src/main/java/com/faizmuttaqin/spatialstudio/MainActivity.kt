package com.faizmuttaqin.spatialstudio

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.faizmuttaqin.spatialstudio.bridge.NativeBridge
import com.faizmuttaqin.spatialstudio.scan.ScanActivity
import com.faizmuttaqin.spatialstudio.scan.ScanStore
import com.faizmuttaqin.spatialstudio.security.PermissionPolicy
import com.faizmuttaqin.spatialstudio.upload.ArtifactUploader
import com.faizmuttaqin.spatialstudio.upload.CookieSource
import com.faizmuttaqin.spatialstudio.upload.HttpArtifactTransport

/** Full-screen WebView on the trusted studio origin, plus the native bridge. */
class MainActivity : ComponentActivity() {

    private val allowlist = AppConfig.allowlist
    private lateinit var webView: WebView
    private var bridge: NativeBridge? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // The page retries getUserMedia; the next request is granted if the user allowed it.
    }

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        createWebView()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )

        val restored = savedInstanceState?.let { webView.restoreState(it) } != null
        if (!restored) webView.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        trustedUrl(intent)?.let(webView::loadUrl)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        bridge?.detach()
        bridge = null
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.webViewClient = StudioWebViewClient()
        webView.webChromeClient = StudioChromeClient()
        // Edge-to-edge on Android 15+: keep the page clear of system bars and cutouts.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
                params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
                view.layoutParams = params
            }
            WindowInsetsCompat.CONSUMED
        }
        setContentView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val store = ScanStore(ScanActivity.scansRoot(this))
        val uploader = ArtifactUploader(
            transport = HttpArtifactTransport(),
            cookies = CookieSource { origin -> CookieManager.getInstance().getCookie(origin) },
            log = { Log.i("SpatialStudioUpload", it) },
        )
        bridge = NativeBridge(this, allowlist, store, uploader) { sessionId ->
            startActivity(ScanActivity.intent(this, sessionId))
        }.also { it.attach(webView) }
    }

    private fun startUrl(intent: Intent?): String = trustedUrl(intent) ?: "${allowlist.home}/"

    /** A launch URL (e.g. from `adb shell am start -d`) is honoured only on a trusted origin. */
    private fun trustedUrl(intent: Intent?): String? =
        intent?.dataString?.takeIf { allowlist.isAllowedNavigation(it) }

    private fun openExternally(uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") {
            Log.i(TAG, "Blocked navigation to a non-web scheme")
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No browser to open an external link")
        }
    }

    private inner class StudioWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Subframes are not top-level navigation; they never get the bridge (isMainFrame check).
            if (!request.isForMainFrame) return false
            if (allowlist.isAllowedNavigation(request.url.toString())) return false
            openExternally(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // Defence in depth: POST navigations and redirects can skip shouldOverrideUrlLoading.
            val scheme = url?.substringBefore(':')?.lowercase()
            if ((scheme == "https" || scheme == "http") && !allowlist.isAllowedNavigation(url)) {
                view.stopLoading()
                view.loadUrl("${allowlist.home}/")
                return
            }
            super.onPageStarted(view, url, favicon)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "WebView renderer gone; recreating")
            bridge?.detach()
            bridge = null
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            createWebView()
            webView.loadUrl("${allowlist.home}/")
            return true
        }
    }

    private inner class StudioChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val hasCamera = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            when (PermissionPolicy.decide(allowlist, request.origin?.toString(), request.resources.toList(), hasCamera)) {
                PermissionPolicy.Decision.GRANT_VIDEO -> request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                PermissionPolicy.Decision.DENY -> request.deny()
                PermissionPolicy.Decision.DENY_AND_REQUEST_CAMERA -> {
                    request.deny()
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            }
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = null
            if (!allowlist.isAllowedNavigation(view.url)) {
                callback.onReceiveValue(null)
                return true
            }
            return try {
                fileCallback = callback
                fileChooser.launch(params.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                callback.onReceiveValue(null)
                true
            }
        }
    }

    private companion object {
        const val TAG = "SpatialStudio"
    }
}
