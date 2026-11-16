package app.homecast.contract

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

// ---- Auth ------------------------------------------------------------------------------------------------------

sealed interface AuthState {
    data object Launching : AuthState
    data object SignedOut : AuthState
    data class SignedIn(val user: User) : AuthState
}

/** Server address + login. Tokens live in encrypted storage (spec §7). Restoring a session works offline. */
interface Session {
    val state: StateFlow<AuthState>
    /** Last used server URL, for pre-filling the sign-in form. */
    val serverUrl: String
    /** Throws [ApiException] / [OfflineException] with a user-presentable message. */
    suspend fun signIn(server: String, username: String, password: String)
    suspend fun register(server: String, username: String, password: String, inviteCode: String?, bootstrapToken: String?)
    suspend fun signOut()
}

class ApiException(val status: Int, override val message: String, val code: String? = null) : Exception(message)
class OfflineException(override val message: String = "You're offline, or the server can't be reached.") : Exception(message)

// ---- Sync (spec §5) ---------------------------------------------------------------------------------------------

enum class SyncStatus { Idle, Syncing, Offline, Error }
data class SyncState(val status: SyncStatus = SyncStatus.Idle, val lastSyncAt: Long? = null, val message: String? = null)

/** Delta sync: push outbox, pull after cursor, repeat while hasMore. Triggers: app open, connectivity regained, local writes (debounced), periodic. */
interface SyncEngine {
    val state: StateFlow<SyncState>
    suspend fun sync()
    /** Debounced sync after local writes. */
    fun schedule(delayMs: Long = 2000)
    /** Called after new data has been merged (wired to auto-downloads, cleanup, speed refresh). */
    var onMerged: (() -> Unit)?
}

// ---- Local library: every screen reads from here; writes queue an outbox row and schedule a sync ---------------

enum class QueuePosition { Next, Last, Front }

interface Library {
    // ---- reads (Flows re-emit when the underlying tables change)
    fun subscribedPodcasts(): Flow<List<Podcast>>
    /** podcastId -> episodes not yet played. */
    fun unplayedCounts(): Flow<Map<String, Int>>
    fun podcast(id: String): Flow<Podcast?>
    fun subscription(podcastId: String): Flow<Subscription?>
    fun subscribedPodcastIds(): Flow<Set<String>>
    fun episodesForPodcast(podcastId: String): Flow<List<EpisodeItem>>
    fun episode(id: String): Flow<EpisodeItem?>
    /** Newest episodes across subscribed podcasts. */
    fun latestEpisodes(limit: Int = 100): Flow<List<EpisodeItem>>
    fun starredEpisodes(): Flow<List<EpisodeItem>>
    fun starredCount(): Flow<Int>
    /** In-progress episodes of subscribed podcasts, most recently played first. */
    fun continueListening(limit: Int = 8): Flow<List<EpisodeItem>>
    /** Up Next (the built-in playlist), in order. */
    fun queue(): Flow<List<EpisodeItem>>
    /** Manual playlists (excluding Up Next), by name. */
    fun playlists(): Flow<List<Playlist>>
    fun playlist(id: String): Flow<PlaylistWithItems?>
    fun smartPlaylists(): Flow<List<SmartPlaylistSummary>>
    fun smartPlaylist(id: String): Flow<SmartPlaylistWithItems?>
    fun bookmarks(): Flow<List<BookmarkItem>>
    fun bookmarkCount(): Flow<Int>
    fun bookmarksForEpisode(episodeId: String): Flow<List<Bookmark>>
    /** Downloaded episodes, newest download first. */
    fun downloads(): Flow<List<EpisodeItem>>
    fun downloadedBytes(): Flow<Long>
    fun settings(): Flow<UserSettings>

    // ---- one-shot reads (service, Android Auto, background work)
    suspend fun getEpisodeItem(id: String): EpisodeItem?
    suspend fun getEpisodeItems(ids: List<String>): List<EpisodeItem>   // preserves the order of [ids]
    suspend fun getState(episodeId: String): EpisodeState
    suspend fun getSettings(): UserSettings
    suspend fun queueIds(): List<String>
    suspend fun evaluate(definition: SmartPlaylistDefinition): List<String>
    suspend fun allSubscriptions(): List<Subscription>
    suspend fun smartPlaylistsSnapshot(): List<SmartPlaylistSummary>
    suspend fun episodesOf(podcastId: String): List<Episode>   // newest first
    suspend fun transcript(episodeId: String): Transcript?
    suspend fun saveTranscript(t: Transcript)
    suspend fun transcriptPreview(episodeId: String, atMs: Long): String?

    // ---- writes: episode state
    suspend fun markPlayed(episodeId: String)
    suspend fun markUnplayed(episodeId: String)
    suspend fun setStarred(episodeId: String, starred: Boolean)
    /** Position write from the player: local only (no sync scheduled); marks played within 5 s of the end. */
    suspend fun savePosition(episodeId: String, positionMs: Long, durationMs: Long)
    /** Patch the real duration locally once audio metadata loads (feeds without durations). */
    suspend fun updateEpisodeDuration(episodeId: String, durationSec: Double)

    // ---- writes: subscriptions & settings
    suspend fun setAutoDownload(podcastId: String, value: AutoDownload)
    suspend fun unsubscribe(podcastId: String)
    suspend fun ensureSubscriptionLocal(podcastId: String)
    suspend fun setDefaultSpeed(speed: Double)
    /** `null` clears the override (spec §3.3). */
    suspend fun setPodcastSpeed(podcastId: String, speed: Double?)
    suspend fun setCleanupDays(podcastId: String, days: Int?)

    // ---- writes: bookmarks (spec §3.2)
    suspend fun addBookmark(episodeId: String, positionMs: Long, title: String?, note: String?): Bookmark
    suspend fun updateBookmark(id: String, title: String?, note: String?)
    suspend fun deleteBookmark(id: String)

    // ---- writes: playlists (spec §3.6) and Up Next
    suspend fun createPlaylist(name: String, episodeIds: List<String> = emptyList()): String
    suspend fun renamePlaylist(id: String, name: String)
    suspend fun deletePlaylist(id: String)
    suspend fun addToPlaylist(id: String, episodeId: String)
    suspend fun setPlaylistEpisodes(id: String, episodeIds: List<String>)
    suspend fun setQueue(ids: List<String>)
    suspend fun enqueue(episodeId: String, where: QueuePosition, currentId: String? = null)
    suspend fun dequeue(episodeId: String)
    suspend fun moveInQueue(from: Int, to: Int)

    // ---- writes: smart playlists (spec §3.7)
    suspend fun saveSmartPlaylist(id: String?, definition: SmartPlaylistDefinition): String
    suspend fun deleteSmartPlaylist(id: String)

    // ---- download bookkeeping (files are managed by DownloadsController)
    suspend fun allDownloads(): List<DownloadRecord>
    suspend fun downloadRecord(episodeId: String): DownloadRecord?
    suspend fun recordDownload(record: DownloadRecord)
    suspend fun deleteDownloadRecord(episodeId: String)

    /** Opaque per-user key/value (player restore state, discover cache, ...). */
    suspend fun kvGet(key: String): String?
    suspend fun kvSet(key: String, value: String?)
}

// ---- Network-only calls (not part of sync) ---------------------------------------------------------------------

data class DiscoverItem(val id: String, val title: String, val author: String, val imageUrl: String?, val description: String, val subscriberCount: Int, val addedAt: Long)
data class SessionInfo(val id: String, val deviceName: String, val createdAt: Long, val lastUsedAt: Long, val current: Boolean)
data class OpmlResult(val imported: Int, val failed: Int)

sealed interface TranscriptStatus {
    data class Ready(val transcript: Transcript) : TranscriptStatus
    data object None : TranscriptStatus
    data object Offline : TranscriptStatus
    data class Pending(val stage: String?, val progress: Double?, val queuePosition: Int?) : TranscriptStatus
}

/** Every method may throw [OfflineException] or [ApiException]. */
interface Remote {
    suspend fun discover(query: String?, sort: String /* subscribers | recent | az */): List<DiscoverItem>
    /** Subscribe by podcast id (Discover). The caller then calls `Library.ensureSubscriptionLocal` and syncs. */
    suspend fun subscribe(podcastId: String)
    /** Add by feed URL; returns the new podcast's id and title. Caller syncs afterwards. */
    suspend fun addPodcast(feedUrl: String, private: Boolean): Pair<String, String>
    suspend fun importOpml(opml: String): OpmlResult
    suspend fun exportOpml(): String
    suspend fun exportData(): String
    suspend fun sessions(): List<SessionInfo>
    suspend fun revokeSession(id: String)
    suspend fun changePassword(current: String, new: String)
    /** Cached transcript first, then the server. Never throws for "not found" / offline: returns the matching status. */
    suspend fun loadTranscript(episodeId: String): TranscriptStatus
    /** Queue generation (any user may; deduplicated per episode). */
    suspend fun requestTranscript(episodeId: String): TranscriptStatus
    /**
     * A signed, short-lived URL for streaming the server's hosted copy of an episode (episode hosting). It plays without an
     * Authorization header, so ExoPlayer can use it directly. `null` when the episode isn't hosted or the server can't be
     * reached within a few seconds; the caller then streams from the podcast's own URL. Never throws.
     */
    suspend fun streamUrl(episodeId: String): String? = null
}

// ---- Playback (implemented in :playback) ------------------------------------------------------------------------

data class PlayContext(val label: String = "Up Next", val ids: List<String>? = null)

sealed interface SleepMode {
    data object Off : SleepMode
    data class Timer(val endsAtMs: Long) : SleepMode
    data object EndOfEpisode : SleepMode
}

enum class SpeedScope { Podcast, Global }

data class PlayerState(
    val episode: Episode? = null,
    val podcast: Podcast? = null,
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val speed: Double = 1.0,
    val speedIsOverride: Boolean = false,
    val sleep: SleepMode = SleepMode.Off,
    val isFading: Boolean = false,
    val context: PlayContext = PlayContext(),
    val error: String? = null,
    val playingOffline: Boolean = false,
) {
    val hasEpisode get() = episode != null
    val progress: Float get() = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
}

/** UI-facing player. Backed by a Media3 `MediaLibraryService` so playback survives the UI and drives Android Auto. */
interface PlayerController {
    val state: StateFlow<PlayerState>
    /** Play [episodeId]; playback then advances through [ids] (if given), then Up Next. */
    fun play(episodeId: String, ids: List<String>? = null, label: String = "Up Next")
    fun toggle()
    fun pause()
    fun resume()
    fun seekTo(ms: Long)
    fun skip(seconds: Int)
    fun back()      // 15 s
    fun forward()   // 30 s
    fun next()
    fun setSpeed(speed: Double, scope: SpeedScope)
    fun clearSpeedOverride()
    /** Re-resolve speed after settings change (also after sync). */
    fun refreshSpeed()
    fun setSleep(mode: SleepMode)
    fun setSleepTimer(minutes: Int)
    /** Adds minutes to a running timer or restarts one (shake or tap while fading). */
    fun extendSleep(minutes: Int = 5)
    fun addBookmarkAtCurrent(title: String? = null, note: String? = null)
    /** Restore the last episode (paused) so the mini player shows after a relaunch. */
    fun restore()
}

data class DeviceSettings(val wifiOnly: Boolean = true, val storageCapMb: Int = 0 /* 0 = unlimited */)

/** Offline audio (spec §3.5): WorkManager downloads straight from the podcast CDN into app storage. */
interface DownloadsController {
    /** episodeId -> 0..1 (or -1 while queued). */
    val active: StateFlow<Map<String, Float>>
    val errors: StateFlow<Map<String, String>>
    val deviceSettings: StateFlow<DeviceSettings>
    fun updateDeviceSettings(settings: DeviceSettings)
    fun enqueue(episodeId: String)
    fun cancel(episodeId: String)
    fun remove(episodeId: String)
    fun removeAll()
    fun fileFor(episodeId: String): File?
    /** Auto-download rules (latest N / all new) and smart playlists flagged "auto-download results". */
    fun runAutoDownloads()
    /** Per-podcast "delete played after N days". */
    fun cleanup()
    fun enforceCap()
}

// ---- The graph -------------------------------------------------------------------------------------------------

interface HomecastGraph {
    val session: Session
    /** Delegates to the signed-in user's database. Calls while signed out throw IllegalStateException. */
    val library: Library
    val remote: Remote
    val sync: SyncEngine
    val player: PlayerController
    val downloads: DownloadsController
}

/** Implemented by the `Application`; the playback service and Android Auto use it to reach the graph. */
interface GraphProvider { val graph: HomecastGraph }
