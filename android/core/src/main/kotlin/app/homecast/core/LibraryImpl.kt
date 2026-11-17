package app.homecast.core

import androidx.room.withTransaction
import app.homecast.contract.*
import app.homecast.core.db.*
import kotlinx.coroutines.flow.*

/**
 * The per-user local library (port of iOS `LocalData` + `AppDatabase` queries). Writes stamp `clientUpdatedAt`, queue an
 * outbox row in the same transaction and schedule a sync (except [savePosition]).
 */
class LibraryImpl(
    private val db: AppDb,
    val userId: String,
    private val sync: () -> SyncEngine?,
    private val clock: () -> Long = System::currentTimeMillis,
) : Library {
    private val dao get() = db.dao()

    // ---- plumbing ---------------------------------------------------------------------------------------------

    @OptIn(kotlinx.coroutines.FlowPreview::class)
    private fun <T> observe(vararg tables: String, block: suspend () -> T): Flow<T> =
        db.invalidationTracker.createFlow(*tables)
            .onStart { emit(emptySet()) }
            .conflate()
            .map { db.withTransaction { block() } }
            .distinctUntilChanged()

    private fun scheduleSync(delayMs: Long = 2000) { sync()?.schedule(delayMs) }

    private suspend fun queueState(s: EpisodeStateRow) { dao.upsertState(s); dao.enqueueOutbox(OutboxRow(C_STATES, s.id)) }
    private suspend fun queueSub(s: SubscriptionRow) { dao.upsertSubscription(s); dao.enqueueOutbox(OutboxRow(C_SUBS, s.id)) }
    private suspend fun queueBookmark(b: BookmarkRow) { dao.upsertBookmark(b); dao.enqueueOutbox(OutboxRow(C_BOOKMARKS, b.id)) }
    private suspend fun queuePlaylist(p: PlaylistRow) { dao.upsertPlaylist(p); dao.enqueueOutbox(OutboxRow(C_PLAYLISTS, p.id)) }
    private suspend fun queueSmart(p: SmartPlaylistRow) { dao.upsertSmartPlaylist(p); dao.enqueueOutbox(OutboxRow(C_SMART, p.id)) }
    private suspend fun queueSettings(s: SettingsRow) { dao.upsertSettings(s); dao.enqueueOutbox(OutboxRow(C_SETTINGS, s.id)) }

    /** Resolve episodes to display items with batched queries (podcast, state, download). */
    private suspend fun items(episodes: List<EpisodeRow>): List<EpisodeItem> {
        if (episodes.isEmpty()) return emptyList()
        val podcasts = episodes.map { it.podcastId }.distinct().chunked(CHUNK).flatMap { dao.podcastsByIds(it) }.associateBy { it.id }
        val ids = episodes.map { it.id }
        val states = HashMap<String, EpisodeStateRow>()
        val downloaded = HashSet<String>()
        for (chunk in ids.chunked(CHUNK)) {
            dao.liveStates(chunk).forEach { states[it.episodeId] = it }
            downloaded += dao.downloadedIn(chunk)
        }
        return episodes.map { EpisodeItem(it.toModel(), podcasts[it.podcastId]?.toModel(), states[it.id]?.toModel(), it.id in downloaded) }
    }

    /** Episodes by id, preserving the requested order (queues and playlists). */
    private suspend fun orderedItems(ids: List<String>): List<EpisodeItem> {
        if (ids.isEmpty()) return emptyList()
        val eps = ids.distinct().chunked(CHUNK).flatMap { dao.episodesByIds(it) }.associateBy { it.id }
        return items(ids.mapNotNull { eps[it] })
    }

    private suspend fun episodeViews(): List<EpisodeView> {
        val subs = dao.subscribedPodcastIds().toSet()
        if (subs.isEmpty()) return emptyList()
        val states = dao.allLiveStates().associateBy { it.episodeId }
        val downloaded = dao.downloadedIds().toHashSet()
        return dao.allEpisodes().filter { it.podcastId in subs }.map {
            val s = states[it.id]
            EpisodeView(it.id, it.podcastId, it.title, it.releasedAt, it.durationSec, PlayStatus.fromWire(s?.status), it.id in downloaded, s?.starred ?: false)
        }
    }

    private suspend fun evaluateIn(views: List<EpisodeView>, def: SmartPlaylistDefinition) = SmartEvaluator.evaluate(def, views, clock())

    private suspend fun loadSettings(): SettingsRow = dao.settingsById(RecordID.settings(userId)).takeIf { it?.deleted == false } ?: SettingsRow(id = RecordID.settings(userId))

    private suspend fun loadState(episodeId: String): EpisodeStateRow =
        dao.stateFor(episodeId) ?: EpisodeStateRow(id = RecordID.state(userId, episodeId), episodeId = episodeId)

    private suspend fun queueRow(): PlaylistRow? = dao.playlistById(RecordID.upNext(userId))?.takeIf { !it.deleted }

    // ---- reads (reactive) -------------------------------------------------------------------------------------

    override fun subscribedPodcasts() = observe("podcast", "subscription") { dao.subscribedPodcasts().map { it.toModel() } }
    override fun unplayedCounts() = observe("episode", "episodeState") { dao.unplayedCounts().associate { it.podcastId to it.n } }
    override fun podcast(id: String) = observe("podcast") { dao.podcast(id)?.toModel() }
    override fun subscription(podcastId: String) = observe("subscription") { dao.liveSubscription(podcastId)?.toModel() }
    override fun subscribedPodcastIds() = observe("subscription") { dao.subscribedPodcastIds().toSet() }
    override fun episodesForPodcast(podcastId: String) = observe("episode", "podcast", "episodeState", "download") { items(dao.episodesOf(podcastId)) }
    override fun episode(id: String) = observe("episode", "podcast", "episodeState", "download") { items(listOfNotNull(dao.episode(id))).firstOrNull() }
    override fun latestEpisodes(limit: Int) = observe("episode", "podcast", "subscription", "episodeState", "download") { items(dao.latestEpisodes(limit)) }
    override fun starredEpisodes() = observe("episode", "podcast", "episodeState", "download") { items(dao.starredEpisodes()) }
    override fun starredCount() = observe("episodeState") { dao.starredCount() }
    override fun continueListening(limit: Int) = observe("episode", "podcast", "subscription", "episodeState", "download") { items(dao.continueListening(limit)) }
    override fun queue() = observe("playlist", "episode", "podcast", "episodeState", "download") { orderedItems(queueRow()?.episodeIds.orEmpty()) }
    override fun playlists() = observe("playlist") { dao.livePlaylists().map { it.toModel() } }

    override fun playlist(id: String) = observe("playlist", "episode", "podcast", "episodeState", "download") {
        val p = dao.playlistById(id)?.takeIf { !it.deleted } ?: return@observe null
        PlaylistWithItems(p.toModel(), orderedItems(p.episodeIds))
    }

    override fun smartPlaylists() = observe("smartPlaylist", "episode", "subscription", "episodeState", "download") { smartSummaries() }
    private suspend fun smartSummaries(): List<SmartPlaylistSummary> {
        val rows = dao.liveSmartPlaylists()
        if (rows.isEmpty()) return emptyList()
        val views = episodeViews()
        return rows.map { SmartPlaylistSummary(it.id, it.definition, evaluateIn(views, it.definition).size) }
    }

    override fun smartPlaylist(id: String) = observe("smartPlaylist", "episode", "podcast", "subscription", "episodeState", "download") {
        val p = dao.smartPlaylistById(id)?.takeIf { !it.deleted } ?: return@observe null
        SmartPlaylistWithItems(p.id, p.definition, orderedItems(evaluateIn(episodeViews(), p.definition)))
    }

    override fun bookmarks() = observe("bookmark", "episode", "podcast", "transcript") {
        val rows = dao.liveBookmarks()
        val eps = rows.map { it.episodeId }.distinct().chunked(CHUNK).flatMap { dao.episodesByIds(it) }.associateBy { it.id }
        val pods = eps.values.map { it.podcastId }.distinct().chunked(CHUNK).flatMap { dao.podcastsByIds(it) }.associateBy { it.id }
        rows.map { b ->
            val ep = eps[b.episodeId]
            BookmarkItem(b.toModel(), ep?.toModel(), ep?.let { pods[it.podcastId]?.toModel() }, dao.transcript(b.episodeId)?.toModel()?.let { previewOf(it, b.positionMs) })
        }
    }
    override fun bookmarkCount() = observe("bookmark") { dao.bookmarkCount() }
    override fun bookmarksForEpisode(episodeId: String) = observe("bookmark") { dao.bookmarksFor(episodeId).map { it.toModel() } }

    override fun downloads() = observe("download", "episode", "podcast", "episodeState") { orderedItems(dao.allDownloads().map { it.episodeId }) }
    override fun downloadedBytes() = observe("download") { dao.downloadedBytes() }
    override fun settings() = observe("settings") { loadSettings().toModel() }

    // ---- reads (one-shot) -------------------------------------------------------------------------------------

    override suspend fun getEpisodeItem(id: String) = items(listOfNotNull(dao.episode(id))).firstOrNull()
    override suspend fun getEpisodeItems(ids: List<String>) = orderedItems(ids)
    override suspend fun getState(episodeId: String) = loadState(episodeId).toModel()
    override suspend fun getSettings() = loadSettings().toModel()
    override suspend fun queueIds() = queueRow()?.episodeIds.orEmpty()
    override suspend fun evaluate(definition: SmartPlaylistDefinition) = db.withTransaction { evaluateIn(episodeViews(), definition) }
    override suspend fun allSubscriptions() = dao.liveSubscriptions().map { it.toModel() }
    override suspend fun smartPlaylistsSnapshot() = db.withTransaction { smartSummaries() }
    override suspend fun episodesOf(podcastId: String) = dao.episodesOf(podcastId).map { it.toModel() }
    override suspend fun transcript(episodeId: String) = dao.transcript(episodeId)?.toModel()
    override suspend fun saveTranscript(t: Transcript) = dao.upsertTranscript(t.toRow())
    override suspend fun transcriptPreview(episodeId: String, atMs: Long) = dao.transcript(episodeId)?.toModel()?.let { previewOf(it, atMs) }

    private fun previewOf(t: Transcript, atMs: Long): String? = (t.segments.lastOrNull { it.startMs <= atMs } ?: t.segments.firstOrNull())?.text

    // ---- writes: episode state --------------------------------------------------------------------------------

    private suspend fun patchState(episodeId: String, positionUpdated: Boolean = false, syncSoon: Boolean = true, mutate: (EpisodeStateRow) -> EpisodeStateRow) {
        db.withTransaction {
            val now = clock()
            var s = mutate(loadState(episodeId)).copy(clientUpdatedAt = now, deleted = false)
            if (positionUpdated) s = s.copy(positionUpdatedAt = now)
            queueState(s)
        }
        if (syncSoon) scheduleSync()
    }

    override suspend fun markPlayed(episodeId: String) = patchState(episodeId) { it.copy(status = "played", playedAt = clock()) }
    override suspend fun markUnplayed(episodeId: String) =
        patchState(episodeId, positionUpdated = true) { it.copy(status = "unplayed", positionMs = 0, playedAt = null) }
    override suspend fun setStarred(episodeId: String, starred: Boolean) = patchState(episodeId) { it.copy(starred = starred) }

    override suspend fun savePosition(episodeId: String, positionMs: Long, durationMs: Long) {
        val nearEnd = durationMs > 0 && positionMs >= durationMs - 5000
        patchState(episodeId, positionUpdated = true, syncSoon = false) {
            it.copy(
                positionMs = positionMs,
                status = if (nearEnd) "played" else if (positionMs > 1000) "inProgress" else "unplayed",
                playedAt = if (nearEnd) clock() else it.playedAt,
            )
        }
    }

    override suspend fun updateEpisodeDuration(episodeId: String, durationSec: Double) { if (durationSec > 0) dao.setDuration(episodeId, durationSec) }

    // ---- writes: subscriptions & settings ---------------------------------------------------------------------

    override suspend fun setAutoDownload(podcastId: String, value: AutoDownload) {
        db.withTransaction {
            val s = dao.liveSubscription(podcastId) ?: return@withTransaction
            queueSub(s.copy(autoDownload = AutoDownloadW(value.mode.wire, value.count), clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    override suspend fun setNotifyNewEpisodes(podcastId: String, on: Boolean) {
        db.withTransaction {
            val s = dao.liveSubscription(podcastId) ?: return@withTransaction
            queueSub(s.copy(newEpisodeNotify = on, clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    override suspend fun unsubscribe(podcastId: String) {
        db.withTransaction {
            val s = dao.liveSubscription(podcastId) ?: return@withTransaction
            queueSub(s.copy(deleted = true, clientUpdatedAt = clock()))
        }
        scheduleSync(300)
    }

    /** After subscribing through the API (Discover), mirror the subscription locally so the UI updates at once. */
    override suspend fun ensureSubscriptionLocal(podcastId: String) {
        db.withTransaction {
            val existing = dao.anySubscription(podcastId)
            if (existing != null && !existing.deleted) return@withTransaction
            queueSub(SubscriptionRow(existing?.id ?: RecordID.subscription(userId, podcastId), podcastId, clientUpdatedAt = clock()))
        }
    }

    private suspend fun updateSettings(mutate: (SettingsRow) -> SettingsRow) {
        db.withTransaction { queueSettings(mutate(loadSettings()).copy(clientUpdatedAt = clock(), deleted = false)) }
        scheduleSync()
    }

    override suspend fun setDefaultSpeed(speed: Double) = updateSettings { it.copy(defaultSpeed = roundSpeed(speed)) }
    override suspend fun setPodcastSpeed(podcastId: String, speed: Double?) = updateSettings {
        it.copy(podcastSpeeds = if (speed != null) it.podcastSpeeds + (podcastId to roundSpeed(speed)) else it.podcastSpeeds - podcastId)
    }
    override suspend fun setCleanupDays(podcastId: String, days: Int?) = updateSettings {
        val c = it.cleanupDays().toMutableMap()
        if (days != null) c[podcastId] = days else c.remove(podcastId)
        it.withCleanupDays(c)
    }

    // ---- writes: bookmarks ------------------------------------------------------------------------------------

    override suspend fun addBookmark(episodeId: String, positionMs: Long, title: String?, note: String?): Bookmark {
        val now = clock()
        val b = BookmarkRow(RecordID.new(), episodeId, positionMs, title.trimmedOrNull(), note.trimmedOrNull(), now, now)
        db.withTransaction { queueBookmark(b) }
        scheduleSync()
        return b.toModel()
    }

    override suspend fun updateBookmark(id: String, title: String?, note: String?) {
        db.withTransaction {
            val b = dao.bookmarkById(id) ?: return@withTransaction
            queueBookmark(b.copy(title = title.trimmedOrNull(), note = note.trimmedOrNull(), clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    override suspend fun deleteBookmark(id: String) {
        db.withTransaction {
            val b = dao.bookmarkById(id) ?: return@withTransaction
            queueBookmark(b.copy(deleted = true, clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    // ---- writes: playlists and Up Next ------------------------------------------------------------------------

    override suspend fun createPlaylist(name: String, episodeIds: List<String>): String {
        val p = PlaylistRow(RecordID.new(), name.trimmedOrNull() ?: "Untitled", episodeIds, clock())
        db.withTransaction { queuePlaylist(p) }
        scheduleSync()
        return p.id
    }

    private suspend fun updatePlaylist(id: String, mutate: (PlaylistRow) -> PlaylistRow) {
        db.withTransaction {
            val p = dao.playlistById(id) ?: return@withTransaction
            queuePlaylist(mutate(p).copy(clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    override suspend fun renamePlaylist(id: String, name: String) = updatePlaylist(id) { it.copy(name = name.trimmedOrNull() ?: it.name) }
    override suspend fun deletePlaylist(id: String) = updatePlaylist(id) { it.copy(deleted = true) }
    override suspend fun addToPlaylist(id: String, episodeId: String) =
        updatePlaylist(id) { if (episodeId in it.episodeIds) it else it.copy(episodeIds = it.episodeIds + episodeId) }
    override suspend fun setPlaylistEpisodes(id: String, episodeIds: List<String>) = updatePlaylist(id) { it.copy(episodeIds = episodeIds) }

    override suspend fun setQueue(ids: List<String>) {
        db.withTransaction { writeQueue(ids) }
        scheduleSync()
    }

    private suspend fun writeQueue(ids: List<String>) {
        queuePlaylist(PlaylistRow(RecordID.upNext(userId), RecordID.UP_NEXT_NAME, ids.distinct(), clock()))
    }

    override suspend fun enqueue(episodeId: String, where: QueuePosition, currentId: String?) {
        db.withTransaction {
            val q = queueRow()?.episodeIds.orEmpty().filter { it != episodeId }.toMutableList()
            when (where) {
                QueuePosition.Front -> q.add(0, episodeId)
                QueuePosition.Next -> q.add(if (q.firstOrNull() != null && q.first() == currentId) 1 else 0, episodeId)
                QueuePosition.Last -> q.add(episodeId)
            }
            writeQueue(q)
        }
        scheduleSync()
    }

    override suspend fun dequeue(episodeId: String) {
        db.withTransaction { writeQueue(queueRow()?.episodeIds.orEmpty().filter { it != episodeId }) }
        scheduleSync()
    }

    /** Moves the item at [from] so it ends up at index [to] (indices of the list as it is now). */
    override suspend fun moveInQueue(from: Int, to: Int) {
        db.withTransaction {
            val q = queueRow()?.episodeIds.orEmpty().toMutableList()
            if (from !in q.indices) return@withTransaction
            val item = q.removeAt(from)
            q.add(to.coerceIn(0, q.size), item)
            writeQueue(q)
        }
        scheduleSync()
    }

    // ---- writes: smart playlists ------------------------------------------------------------------------------

    override suspend fun saveSmartPlaylist(id: String?, definition: SmartPlaylistDefinition): String {
        val rid = id ?: RecordID.new()
        val def = definition.copy(name = definition.name.trimmedOrNull() ?: "Untitled")
        db.withTransaction { queueSmart(SmartPlaylistRow(rid, def.name, def, clock())) }
        scheduleSync()
        return rid
    }

    override suspend fun deleteSmartPlaylist(id: String) {
        db.withTransaction {
            val p = dao.smartPlaylistById(id) ?: return@withTransaction
            queueSmart(p.copy(deleted = true, clientUpdatedAt = clock()))
        }
        scheduleSync()
    }

    // ---- downloads & kv ---------------------------------------------------------------------------------------

    override suspend fun allDownloads() = dao.allDownloads().map { it.toModel() }
    override suspend fun downloadRecord(episodeId: String) = dao.download(episodeId)?.toModel()
    override suspend fun recordDownload(record: DownloadRecord) = dao.upsertDownload(record.toRow())
    override suspend fun deleteDownloadRecord(episodeId: String) = dao.deleteDownload(episodeId)

    override suspend fun kvGet(key: String) = dao.kvGet(key)
    override suspend fun kvSet(key: String, value: String?) { if (value == null) dao.kvDelete(key) else dao.upsertKv(KvRow(key, value)) }

    companion object {
        const val C_STATES = "episodeStates"; const val C_SUBS = "subscriptions"; const val C_BOOKMARKS = "bookmarks"
        const val C_PLAYLISTS = "playlists"; const val C_SMART = "smartPlaylists"; const val C_SETTINGS = "settings"
        private const val CHUNK = 500
        fun roundSpeed(s: Double): Double = Math.round(s.coerceIn(0.5, 3.0) * 10) / 10.0
    }
}

internal fun String?.trimmedOrNull(): String? = this?.trim()?.takeIf { it.isNotEmpty() }
