package app.homecast.playback

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.homecast.contract.DownloadRecord
import app.homecast.contract.GraphProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

/** Downloads one episode into `filesDir/downloads/<episodeId>.<ext>` (resumable via HTTP Range) and records it in the library. */
internal class DownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val episodeId get() = inputData.getString(DownloadStorage.KEY_ID).orEmpty()
    private var title: String = ""

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground(-1f)

    private fun foreground(progress: Float): ForegroundInfo {
        val ctx = applicationContext
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, ctx.getString(R.string.playback_downloads_channel_name), NotificationManager.IMPORTANCE_LOW))
        }
        val cancel = WorkManager.getInstance(ctx).createCancelPendingIntent(id)
        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(ctx.getString(R.string.playback_downloads_title))
            .setContentText(title.ifBlank { null })
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, (progress.coerceAtLeast(0f) * 100).toInt(), progress < 0f)
            .addAction(0, ctx.getString(R.string.playback_downloads_cancel), cancel)
            .build()
        val nid = NOTIFICATION_BASE + (episodeId.hashCode() and 0xFFFF)
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(nid, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(nid, n)
    }

    private fun fail(message: String) = Result.failure(workDataOf(DownloadStorage.KEY_ERROR to message))
    private fun retryOrFail(message: String) = if (runAttemptCount >= MAX_ATTEMPTS) fail(message) else Result.retry()

    override suspend fun doWork(): Result {
        val id = episodeId
        if (id.isEmpty()) return fail("Episode not found")
        val graph = (applicationContext as? GraphProvider)?.graph ?: return fail("Download failed")
        val lib = runCatching { graph.library }.getOrNull() ?: return fail("Sign in to download episodes")
        val ep = lib.getEpisodeItem(id)?.episode ?: return fail("Episode not found")
        title = ep.title
        val dir = DownloadStorage.dir(applicationContext)
        if (DownloadStorage.file(applicationContext, id) != null && lib.downloadRecord(id) != null) return Result.success()

        runCatching { setForeground(foreground(-1f)) } // may be refused when started from the background; the work still runs

        val part = File(dir, "$id.part")
        val request = try {
            Request.Builder().url(ep.audioUrl).apply { if (part.length() > 0) header("Range", "bytes=${part.length()}-") }.build()
        } catch (e: IllegalArgumentException) {
            return fail("This episode has no downloadable audio.")
        }

        return try {
            val call = client.newCall(request)
            val handle = currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
            try {
                withContext(Dispatchers.IO) { call.execute() }.use { resp ->
                    val code = resp.code
                    if (code == 416) { part.delete(); return Result.retry() }
                    if (!resp.isSuccessful) {
                        return if (code in 400..499 && code != 408 && code != 429) fail("Download failed (HTTP $code)") else retryOrFail("Download failed (HTTP $code)")
                    }
                    val body = resp.body
                    val resumed = code == 206 && part.length() > 0
                    val offset = if (resumed) part.length() else 0L
                    val total = if (body.contentLength() >= 0) offset + body.contentLength() else -1L
                    withContext(Dispatchers.IO) {
                        RandomAccessFile(part, "rw").use { raf ->
                            if (!resumed) raf.setLength(0) else raf.seek(offset)
                            val buf = ByteArray(64 * 1024)
                            var written = offset
                            var lastReport = 0L
                            body.byteStream().use { input ->
                                while (true) {
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    raf.write(buf, 0, n)
                                    written += n
                                    val now = System.currentTimeMillis()
                                    if (total > 0 && now - lastReport > 500) {
                                        lastReport = now
                                        val p = (written.toDouble() / total).toFloat().coerceIn(0f, 1f)
                                        currentCoroutineContext().ensureActive()
                                        setProgress(workDataOf(DownloadStorage.KEY_PROGRESS to p))
                                        runCatching { setForeground(foreground(p)) }
                                    }
                                }
                            }
                        }
                    }
                    if (part.length() == 0L) return fail("The download was empty.")
                    if (total > 0 && part.length() < total) return retryOrFail("Download interrupted")
                    DownloadStorage.deleteFinished(applicationContext, id) // other extensions of an older copy
                    val ext = DownloadNaming.extension(ep.audioUrl, resp.header("Content-Type") ?: ep.mimeType)
                    val dest = File(dir, "$id.$ext")
                    if (!part.renameTo(dest)) { part.copyTo(dest, overwrite = true); part.delete() }
                    lib.recordDownload(DownloadRecord(id, ep.podcastId, dest.length(), System.currentTimeMillis(), dest.name))
                }
            } finally {
                handle.dispose()
            }
            runCatching { graph.downloads.enforceCap() }
            Result.success()
        } catch (e: IOException) {
            if (e.message?.contains("ENOSPC") == true || e.message?.contains("No space", ignoreCase = true) == true) fail("Not enough storage space.")
            else if (!isStopped) retryOrFail("Download failed. Check your connection and try again.") else Result.retry()
        }
    }

    private companion object {
        const val CHANNEL_ID = "homecast_downloads"
        const val NOTIFICATION_BASE = 7000
        const val MAX_ATTEMPTS = 5
        val client: OkHttpClient by lazy {
            OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
        }
    }
}
