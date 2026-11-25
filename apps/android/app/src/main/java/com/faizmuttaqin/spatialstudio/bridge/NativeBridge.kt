package com.faizmuttaqin.spatialstudio.bridge

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.faizmuttaqin.spatialstudio.AppConfig
import com.faizmuttaqin.spatialstudio.BuildConfig
import com.faizmuttaqin.spatialstudio.capabilities.CapabilityProbe
import com.faizmuttaqin.spatialstudio.scan.ScanCoordinator
import com.faizmuttaqin.spatialstudio.scan.ScanParams
import com.faizmuttaqin.spatialstudio.scan.ScanStartParams
import com.faizmuttaqin.spatialstudio.scan.ScanStore
import com.faizmuttaqin.spatialstudio.scan.SessionRecord
import com.faizmuttaqin.spatialstudio.security.OriginAllowlist
import com.faizmuttaqin.spatialstudio.upload.ArtifactUploader
import com.faizmuttaqin.spatialstudio.upload.UploadFailedException
import com.faizmuttaqin.spatialstudio.upload.UploadLog
import com.faizmuttaqin.spatialstudio.upload.UploadResults
import com.faizmuttaqin.spatialstudio.util.JsonUtil
import com.google.ar.core.ArCoreApk
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Bridge protocol v1 (CAPTURE_CONTRACT.md) over `WebViewCompat.addWebMessageListener`.
 * Requests are validated here and handled off the main thread; replies and events
 * are posted back on the main thread.
 */
class NativeBridge(
    context: Context,
    private val allowlist: OriginAllowlist,
    private val store: ScanStore,
    private val uploader: ArtifactUploader,
    private val host: Host,
) : WebViewCompat.WebMessageListener, ScanCoordinator.Listener {

    fun interface Host {
        /** Opens the native scan screen; called on the main thread. */
        fun launchScan(sessionId: String)
    }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val uploads: ExecutorService = Executors.newSingleThreadExecutor()

    /** Events go to the page that most recently sent a valid request. */
    @Volatile
    private var eventProxy: JavaScriptReplyProxy? = null

    fun attach(webView: WebView): Boolean {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, AppConfig.BRIDGE_OBJECT_NAME, allowlist.webMessageRules, this)
            ScanCoordinator.addListener(this)
            worker.execute { sweepStaleScans() }
            return true
        }
        Log.w(TAG, "WebView does not support WebMessageListener; bridge disabled")
        return false
    }

    fun detach() {
        ScanCoordinator.removeListener(this)
        eventProxy = null
        worker.shutdown()
        // A running upload finishes; its reply is dropped if the page is gone.
        uploads.shutdown()
    }

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        // The listener is only injected for allowlisted origins; check again per message anyway.
        val origin = allowlist.match(sourceOrigin.toString()) ?: return
        if (!isMainFrame) {
            post(replyProxy, BridgeProtocol.errorReply("", BridgeErrorCode.FORBIDDEN, "The bridge is only available to the top-level page"))
            return
        }
        val data = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
        when (val parsed = BridgeProtocol.parse(data)) {
            is BridgeProtocol.Parsed.Error -> post(replyProxy, BridgeProtocol.errorReply(parsed.id, parsed.code, parsed.message))
            is BridgeProtocol.Parsed.Ok -> {
                eventProxy = replyProxy
                dispatch(parsed.request, origin, replyProxy)
            }
        }
    }

    override fun onScanEvent(event: String, data: JsonObject) {
        val proxy = eventProxy ?: return
        post(proxy, BridgeProtocol.event(event, data))
    }

    private fun dispatch(request: BridgeRequest, origin: OriginAllowlist.Origin, proxy: JavaScriptReplyProxy) {
        if (request.method == "scan.upload") {
            startUpload(request, origin, proxy)
            return
        }
        worker.execute {
            val reply = try {
                BridgeProtocol.okReply(request.id, handle(request))
            } catch (e: BridgeException) {
                BridgeProtocol.errorReply(request.id, e.code, e.message.orEmpty())
            } catch (e: Exception) {
                Log.e(TAG, "Bridge method ${request.method} failed", e)
                BridgeProtocol.errorReply(request.id, BridgeErrorCode.INTERNAL, "Internal error in ${request.method}")
            }
            post(proxy, reply, request.id)
        }
    }

    private fun handle(request: BridgeRequest): JsonElement = when (request.method) {
        "bridge.hello" -> buildJsonObject {
            put("bridgeVersion", BridgeProtocol.VERSION)
            put("appVersion", BuildConfig.VERSION_NAME)
            put("platform", "android")
            put("methods", JsonArray(BridgeProtocol.METHODS.map(::JsonPrimitive)))
        }
        "capabilities.get" -> CapabilityProbe(appContext).probe(scanActive = ScanCoordinator.active != null)
        "scan.start" -> startScan(ScanParams.start(request.params))
        "scan.list" -> listScans()
        "scan.discard" -> discard(ScanParams.sessionId(request.params))
        else -> throw BridgeException(BridgeErrorCode.UNKNOWN_METHOD, "Unknown method")
    }

    private fun startScan(params: ScanStartParams): JsonElement {
        val availability = ArCoreApk.getInstance().checkAvailability(appContext)
        if (availability.isUnsupported) {
            throw BridgeException(BridgeErrorCode.UNSUPPORTED, "ARCore is not supported on this device")
        }
        if (store.usableBytes() < MIN_FREE_BYTES) {
            throw BridgeException(BridgeErrorCode.UNSUPPORTED, "Not enough free storage for a scan")
        }
        val sessionId = UUID.randomUUID().toString()
        Log.i(TAG, "scan.start $sessionId")
        if (!ScanCoordinator.begin(ScanCoordinator.ActiveScan(sessionId, params.projectId, params.options))) {
            Log.i(TAG, "scan.start rejected as busy: a scan is already running")
            throw BridgeException(BridgeErrorCode.BUSY, "A scan is already running")
        }
        main.post {
            try {
                host.launchScan(sessionId)
            } catch (e: Exception) {
                Log.e(TAG, "Could not open the scan screen", e)
                ScanCoordinator.end(sessionId)
                ScanCoordinator.state(sessionId, "failed") {
                    put("error", errorJson(BridgeErrorCode.INTERNAL, "Could not open the scan screen"))
                }
            }
        }
        // A start can be dropped without an exception (for example from the background):
        // release the scan if its screen has not opened in time, so later starts are not busy.
        main.postDelayed({
            if (ScanCoordinator.expireIfNotStarted(sessionId)) {
                ScanCoordinator.state(sessionId, "failed") {
                    put("error", errorJson(BridgeErrorCode.INTERNAL, "The scan screen did not open. Keep the app in front and try again."))
                }
            }
        }, START_WATCHDOG_MS)
        return buildJsonObject { put("sessionId", sessionId) }
    }

    private fun listScans(): JsonElement {
        val active = ScanCoordinator.active?.sessionId
        val uploading = ScanCoordinator.uploading
        return JsonArray(
            store.list().map { record ->
                buildJsonObject {
                    put("sessionId", record.sessionId)
                    put("createdAt", JsonUtil.isoUtc(record.createdAtMs))
                    put(
                        "state",
                        when {
                            record.state == SessionRecord.RECORDING && record.sessionId == active -> "scanning"
                            record.state == SessionRecord.RECORDING -> "incomplete"
                            else -> record.state
                        },
                    )
                    put("keyframes", record.keyframes)
                    put("bytes", record.bytes)
                    put("uploaded", record.uploaded)
                    put("uploading", record.sessionId == uploading)
                    put("projectId", record.projectId)
                    record.manifestSha256?.takeIf { record.uploaded }?.let { put("manifestUrl", "/api/artifacts/$it") }
                    record.error?.let { put("error", it) }
                }
            },
        )
    }

    private fun discard(sessionId: String): JsonElement {
        if (ScanCoordinator.active?.sessionId == sessionId) {
            throw BridgeException(BridgeErrorCode.BUSY, "The scan is still running")
        }
        if (ScanCoordinator.uploading == sessionId) {
            throw BridgeException(BridgeErrorCode.BUSY, "The scan is uploading")
        }
        if (!store.discard(sessionId)) throw BridgeException(BridgeErrorCode.NOT_FOUND, "No such scan")
        return buildJsonObject { put("sessionId", sessionId) }
    }

    private fun startUpload(request: BridgeRequest, origin: OriginAllowlist.Origin, proxy: JavaScriptReplyProxy) {
        val sessionId = try {
            ScanParams.sessionId(request.params)
        } catch (e: BridgeException) {
            post(proxy, BridgeProtocol.errorReply(request.id, e.code, e.message.orEmpty()))
            return
        }
        val waiter = ScanCoordinator.UploadWaiter { outcome ->
            post(
                proxy,
                when (outcome) {
                    is ScanCoordinator.UploadOutcome.Ok -> BridgeProtocol.okReply(request.id, outcome.result)
                    is ScanCoordinator.UploadOutcome.Failed -> BridgeProtocol.errorReply(request.id, outcome.code, outcome.message)
                },
                request.id,
            )
        }
        // Disk reads stay off the main thread, and off the upload thread that may be busy.
        worker.execute {
            val done = store.read(sessionId)?.let(UploadResults::alreadyUploaded)
            if (done != null && ScanCoordinator.uploading != sessionId) {
                Log.i(TAG, "scan.upload $sessionId already uploaded; replying without network work")
                post(proxy, BridgeProtocol.okReply(request.id, done), request.id)
                return@execute
            }
            when (ScanCoordinator.beginOrJoinUpload(sessionId, waiter)) {
                ScanCoordinator.UploadJoin.BUSY -> {
                    Log.i(TAG, "scan.upload $sessionId rejected as busy: another session is uploading")
                    post(proxy, BridgeProtocol.errorReply(request.id, BridgeErrorCode.BUSY, "Another upload is running"), request.id)
                }
                ScanCoordinator.UploadJoin.JOINED ->
                    Log.i(TAG, "scan.upload $sessionId joined the upload already running for it")
                ScanCoordinator.UploadJoin.STARTED -> {
                    Log.i(TAG, "scan.upload $sessionId begin")
                    uploads.execute { runUpload(sessionId, origin) }
                }
            }
        }
    }

    private fun runUpload(sessionId: String, origin: OriginAllowlist.Origin) {
        val outcome = try {
            ScanCoordinator.UploadOutcome.Ok(upload(sessionId, origin))
        } catch (e: BridgeException) {
            ScanCoordinator.UploadOutcome.Failed(e.code, e.message.orEmpty())
        } catch (e: UploadFailedException) {
            ScanCoordinator.UploadOutcome.Failed(BridgeErrorCode.UPLOAD_FAILED, e.message.orEmpty())
        } catch (e: Exception) {
            Log.e(TAG, "Upload failed", e)
            ScanCoordinator.UploadOutcome.Failed(BridgeErrorCode.INTERNAL, "Internal error during upload")
        }
        Log.i(TAG, "scan.upload $sessionId end: ${if (outcome is ScanCoordinator.UploadOutcome.Ok) "ok" else "failed"}")
        ScanCoordinator.finishUpload(sessionId, outcome)
    }

    private fun upload(sessionId: String, origin: OriginAllowlist.Origin): JsonObject {
        val record = store.read(sessionId) ?: throw BridgeException(BridgeErrorCode.NOT_FOUND, "No such scan")
        if (record.state != SessionRecord.READY) {
            val reason = record.error?.let { ": $it" }.orEmpty()
            throw BridgeException(BridgeErrorCode.INVALID_REQUEST, "Scan is ${record.state}, not ready to upload$reason")
        }
        val plan = store.uploadPlan(sessionId)
        val log = UploadLog(File(store.dir(sessionId), UploadLog.FILE))
        var lastEventAt = 0L
        val result = uploader.upload(origin, store.dir(sessionId), plan, log) { progress ->
            val now = SystemClock.elapsedRealtime()
            if (progress.uploaded == progress.total || now - lastEventAt >= PROGRESS_INTERVAL_MS) {
                lastEventAt = now
                onScanEvent(
                    "upload.progress",
                    buildJsonObject {
                        put("sessionId", sessionId)
                        put("uploaded", progress.uploaded)
                        put("total", progress.total)
                        put("bytesUploaded", progress.bytesUploaded)
                        put("bytesTotal", progress.bytesTotal)
                    },
                )
            }
        }
        store.write(record.copy(manifestSha256 = result.manifestSha256, uploadedAtMs = System.currentTimeMillis()))
        return buildJsonObject {
            put("sessionId", sessionId)
            put("manifestUrl", result.manifestUrl)
            put("manifestSha256", result.manifestSha256)
        }
    }

    private fun sweepStaleScans() {
        try {
            val removed = store.sweepStale(System.currentTimeMillis(), STALE_RECORDING_MS, ScanCoordinator.active?.sessionId)
            if (removed > 0) Log.i(TAG, "Removed $removed abandoned scan(s)")
        } catch (e: Exception) {
            Log.w(TAG, "Could not sweep abandoned scans", e)
        }
    }

    // A reply proxy only exists once attach() found WEB_MESSAGE_LISTENER supported.
    @SuppressLint("RequiresFeature")
    private fun post(proxy: JavaScriptReplyProxy, message: String, id: String = "") {
        val safe = if (BridgeProtocol.fits(message)) {
            message
        } else {
            BridgeProtocol.errorReply(id, BridgeErrorCode.INTERNAL, "Reply exceeds ${BridgeProtocol.MAX_MESSAGE_BYTES} bytes")
        }
        main.post {
            try {
                proxy.postMessage(safe)
            } catch (e: Exception) {
                Log.w(TAG, "Could not deliver a bridge message", e)
            }
        }
    }

    companion object {
        private const val TAG = "SpatialStudioBridge"
        private const val MIN_FREE_BYTES = 300L * 1024 * 1024
        private const val PROGRESS_INTERVAL_MS = 250L
        private const val START_WATCHDOG_MS = 10_000L
        private const val STALE_RECORDING_MS = 24L * 60 * 60 * 1000

        fun errorJson(code: BridgeErrorCode, message: String) = buildJsonObject {
            put("code", code.wire)
            put("message", message)
        }
    }
}
