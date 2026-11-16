package app.homecast.playback

import android.app.Application
import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.homecast.contract.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal object DownloadStorage {
    const val TAG = "homecast-download"
    const val ID_TAG_PREFIX = "ep:"
    const val KEY_ID = "episodeId"
    const val KEY_PROGRESS = "p"
    const val KEY_ERROR = "error"

    fun dir(context: Context): File = File(context.filesDir, "downloads").apply { mkdirs() }
    fun workName(episodeId: String) = "dl:$episodeId"

    /** The finished file of [episodeId], if present. */
    fun file(context: Context, episodeId: String): File? {
        val d = dir(context)
        return DownloadNaming.extensions.asSequence().map { File(d, "$episodeId.$it") }.firstOrNull { it.isFile }
    }

    /** Finished copies only (keeps a partial download that is about to be finalized). */
    fun deleteFinished(context: Context, episodeId: String) {
        val d = dir(context)
        DownloadNaming.extensions.forEach { File(d, "$episodeId.$it").delete() }
    }

    fun deleteFiles(context: Context, episodeId: String) {
        dir(context).listFiles { f -> f.name.startsWith("$episodeId.") }?.forEach { it.delete() }
    }
}

/**
 * Offline audio (spec §3.5) on WorkManager: one unique expedited work request per episode, files in
 * `filesDir/downloads`, bookkeeping through [Library.recordDownload] & co.
 */
internal class DownloadsControllerImpl(
    private val app: Application,
    private val graphProvider: GraphProvider,
) : DownloadsController {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val prefs = app.getSharedPreferences("homecast_device", Context.MODE_PRIVATE)
    private val work by lazy { WorkManager.getInstance(app) }

    private val _active = MutableStateFlow<Map<String, Float>>(emptyMap())
    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())
    private val _settings = MutableStateFlow(
        DeviceSettings(prefs.getBoolean(PREF_WIFI_ONLY, true), prefs.getInt(PREF_CAP_MB, 0))
    )
    private val autoRunning = AtomicBoolean(false)

    override val active: StateFlow<Map<String, Float>> = _active.asStateFlow()
    override val errors: StateFlow<Map<String, String>> = _errors.asStateFlow()
    override val deviceSettings: StateFlow<DeviceSettings> = _settings.asStateFlow()

    init {
        scope.launch {
            runCatching { work.pruneWork() }
            work.getWorkInfosByTagFlow(DownloadStorage.TAG).collect { infos -> derive(infos) }
        }
    }

    private fun library(): Library? = runCatching { graphProvider.graph.library }.getOrNull()

    /** episodeId -> progress / error, derived from WorkManager (the single source of truth for in-flight work). */
    private fun derive(infos: List<WorkInfo>) {
        val active = LinkedHashMap<String, Float>()
        val failed = HashMap<String, String>()
        val retrying = HashMap<String, String>()
        for (wi in infos) {
            val id = wi.tags.firstOrNull { it.startsWith(DownloadStorage.ID_TAG_PREFIX) }?.removePrefix(DownloadStorage.ID_TAG_PREFIX) ?: continue
            when (wi.state) {
                WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> {
                    active.putIfAbsent(id, -1f)
                    if (wi.runAttemptCount > 0) retrying[id] = "Download failed. It will be retried."
                }
                WorkInfo.State.RUNNING -> active[id] = wi.progress.getFloat(DownloadStorage.KEY_PROGRESS, -1f)
                WorkInfo.State.FAILED -> failed[id] = wi.outputData.getString(DownloadStorage.KEY_ERROR) ?: "Download failed"
                else -> Unit
            }
        }
        _active.value = active
        _errors.value = (failed + retrying).filterKeys { it !in active || it in retrying }
    }

    // ---- settings --------------------------------------------------------------------------------------------------

    override fun updateDeviceSettings(settings: DeviceSettings) {
        val old = _settings.value
        prefs.edit().putBoolean(PREF_WIFI_ONLY, settings.wifiOnly).putInt(PREF_CAP_MB, settings.storageCapMb.coerceAtLeast(0)).apply()
        _settings.value = settings.copy(storageCapMb = settings.storageCapMb.coerceAtLeast(0))
        if (old.wifiOnly != settings.wifiOnly) {
            // Pending/running downloads carry the old network constraint: re-enqueue them under the new one.
            _active.value.keys.forEach { enqueueWork(it, ExistingWorkPolicy.REPLACE) }
        }
        if (old.storageCapMb != settings.storageCapMb) enforceCap()
    }

    // ---- actions ---------------------------------------------------------------------------------------------------

    override fun fileFor(episodeId: String): File? = DownloadStorage.file(app, episodeId)

    override fun enqueue(episodeId: String) {
        if (fileFor(episodeId) != null) return
        _errors.value = _errors.value - episodeId
        runCatching { work.pruneWork() } // drop finished (incl. failed) records so stale errors vanish
        enqueueWork(episodeId, ExistingWorkPolicy.KEEP)
    }

    private fun enqueueWork(episodeId: String, policy: ExistingWorkPolicy) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (_settings.value.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(workDataOf(DownloadStorage.KEY_ID to episodeId))
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(DownloadStorage.TAG)
            .addTag(DownloadStorage.ID_TAG_PREFIX + episodeId)
            .build()
        work.enqueueUniqueWork(DownloadStorage.workName(episodeId), policy, request)
        if (_active.value[episodeId] == null) _active.value = _active.value + (episodeId to -1f)
    }

    override fun cancel(episodeId: String) {
        work.cancelUniqueWork(DownloadStorage.workName(episodeId))
        File(DownloadStorage.dir(app), "$episodeId.part").delete()
        _active.value = _active.value - episodeId
    }

    override fun remove(episodeId: String) {
        cancel(episodeId)
        DownloadStorage.deleteFiles(app, episodeId)
        scope.launch { runCatching { library()?.deleteDownloadRecord(episodeId) } }
    }

    override fun removeAll() {
        work.cancelAllWorkByTag(DownloadStorage.TAG)
        _active.value = emptyMap()
        val dir = DownloadStorage.dir(app)
        dir.listFiles()?.forEach { it.delete() }
        scope.launch {
            val lib = library() ?: return@launch
            runCatching { lib.allDownloads().forEach { lib.deleteDownloadRecord(it.episodeId) } }
        }
    }

    // ---- housekeeping ------------------------------------------------------------------------------------------------

    /** Global storage cap: evict the oldest played downloads, then the oldest of all (spec §3.5). */
    override fun enforceCap() {
        val capBytes = _settings.value.storageCapMb * 1_000_000L
        if (capBytes <= 0) return
        scope.launch {
            val lib = library() ?: return@launch
            val records = runCatching { lib.allDownloads() }.getOrNull() ?: return@launch
            if (records.sumOf { it.bytes } <= capBytes) return@launch
            val played = records.filter { runCatching { lib.getState(it.episodeId).status }.getOrNull() == PlayStatus.Played }.map { it.episodeId }.toSet()
            CapEviction.plan(records, played, capBytes).forEach { remove(it.episodeId) }
        }
    }

    /** Per-podcast "delete played after N days". */
    override fun cleanup() {
        scope.launch {
            val lib = library() ?: return@launch
            val rules = runCatching { lib.getSettings().cleanupDays }.getOrNull() ?: return@launch
            if (rules.isEmpty()) return@launch
            val now = System.currentTimeMillis()
            for (r in runCatching { lib.allDownloads() }.getOrDefault(emptyList())) {
                val days = rules[r.podcastId] ?: continue
                val st = runCatching { lib.getState(r.episodeId) }.getOrNull() ?: continue
                if (CapEviction.shouldCleanUp(st.status, st.playedAt, days, now)) remove(r.episodeId)
            }
        }
    }

    /** Auto-download rules (latest N / all new) and smart playlists flagged "auto-download results". */
    override fun runAutoDownloads() {
        if (!autoRunning.compareAndSet(false, true)) return
        scope.launch {
            try {
                val lib = library() ?: return@launch
                val wanted = LinkedHashSet<String>()
                suspend fun unplayed(id: String) = runCatching { lib.getState(id).status }.getOrNull() != PlayStatus.Played

                for (sub in runCatching { lib.allSubscriptions() }.getOrDefault(emptyList())) {
                    val mode = sub.autoDownload.mode
                    if (mode == AutoDownloadMode.Off) continue
                    val episodes = runCatching { lib.episodesOf(sub.podcastId) }.getOrDefault(emptyList()) // newest first
                    if (mode == AutoDownloadMode.Latest) {
                        for (e in episodes.take(sub.autoDownload.count ?: 3)) if (unplayed(e.id)) wanted += e.id
                    } else {
                        // "all new": episodes released since the subscription was created, capped at 20.
                        var n = 0
                        for (e in episodes) {
                            if (n >= 20) break
                            if (e.releasedAt >= sub.clientUpdatedAt && unplayed(e.id)) { wanted += e.id; n++ }
                        }
                    }
                }
                for (p in runCatching { lib.smartPlaylistsSnapshot() }.getOrDefault(emptyList())) {
                    if (p.definition.autoDownload == true) runCatching { lib.evaluate(p.definition) }.getOrDefault(emptyList()).take(25).forEach { wanted += it }
                }
                val have = runCatching { lib.allDownloads() }.getOrDefault(emptyList()).map { it.episodeId }.toSet()
                for (id in wanted) {
                    if (id in have || id in _active.value || fileFor(id) != null) continue
                    enqueueWork(id, ExistingWorkPolicy.KEEP)
                }
            } finally {
                autoRunning.set(false)
            }
        }
    }

    private companion object {
        const val PREF_WIFI_ONLY = "wifiOnly"
        const val PREF_CAP_MB = "storageCapMb"
    }
}
