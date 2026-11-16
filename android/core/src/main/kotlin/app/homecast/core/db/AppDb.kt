package app.homecast.core.db

import android.content.Context
import androidx.room.*

@Dao
interface HcDao {
    // ---- shared records
    @Upsert suspend fun upsertPodcast(p: PodcastRow)
    @Upsert suspend fun upsertEpisode(e: EpisodeRow)
    @Query("DELETE FROM podcast WHERE id = :id") suspend fun deletePodcast(id: String)
    @Query("DELETE FROM episode WHERE id = :id") suspend fun deleteEpisode(id: String)
    @Query("DELETE FROM podcast") suspend fun deleteAllPodcasts()
    @Query("DELETE FROM episode") suspend fun deleteAllEpisodes()
    @Query("SELECT * FROM podcast WHERE id = :id") suspend fun podcast(id: String): PodcastRow?
    @Query("SELECT * FROM podcast WHERE id IN (:ids)") suspend fun podcastsByIds(ids: List<String>): List<PodcastRow>
    @Query("SELECT * FROM episode WHERE id = :id") suspend fun episode(id: String): EpisodeRow?
    @Query("SELECT * FROM episode WHERE id IN (:ids)") suspend fun episodesByIds(ids: List<String>): List<EpisodeRow>
    @Query("SELECT * FROM episode WHERE podcastId = :podcastId ORDER BY releasedAt DESC, id") suspend fun episodesOf(podcastId: String): List<EpisodeRow>
    @Query("SELECT * FROM episode") suspend fun allEpisodes(): List<EpisodeRow>
    @Query("UPDATE episode SET durationSec = :sec WHERE id = :id") suspend fun setDuration(id: String, sec: Double)

    @Query("SELECT p.* FROM podcast p WHERE p.id IN (SELECT podcastId FROM subscription WHERE deleted = 0) ORDER BY p.title COLLATE NOCASE")
    suspend fun subscribedPodcasts(): List<PodcastRow>

    @Query("""SELECT e.podcastId AS podcastId, COUNT(*) AS n FROM episode e
              LEFT JOIN episodeState s ON s.episodeId = e.id AND s.deleted = 0
              WHERE (s.status IS NULL OR s.status != 'played') GROUP BY e.podcastId""")
    suspend fun unplayedCounts(): List<UnplayedCount>

    @Query("""SELECT * FROM episode WHERE podcastId IN (SELECT podcastId FROM subscription WHERE deleted = 0)
              ORDER BY releasedAt DESC, id LIMIT :limit""")
    suspend fun latestEpisodes(limit: Int): List<EpisodeRow>

    @Query("""SELECT e.* FROM episode e JOIN episodeState s ON s.episodeId = e.id
              WHERE s.starred = 1 AND s.deleted = 0 ORDER BY e.releasedAt DESC, e.id""")
    suspend fun starredEpisodes(): List<EpisodeRow>

    @Query("SELECT COUNT(*) FROM episodeState WHERE starred = 1 AND deleted = 0") suspend fun starredCount(): Int

    @Query("""SELECT e.* FROM episodeState s JOIN episode e ON e.id = s.episodeId
              WHERE s.status = 'inProgress' AND s.deleted = 0
                AND e.podcastId IN (SELECT podcastId FROM subscription WHERE deleted = 0)
              ORDER BY s.positionUpdatedAt DESC, s.clientUpdatedAt DESC LIMIT :limit""")
    suspend fun continueListening(limit: Int): List<EpisodeRow>

    @Query("SELECT podcastId FROM subscription WHERE deleted = 0") suspend fun subscribedPodcastIds(): List<String>

    // ---- episode state
    @Upsert suspend fun upsertState(s: EpisodeStateRow)
    @Query("SELECT * FROM episodeState WHERE id = :id") suspend fun stateById(id: String): EpisodeStateRow?
    @Query("SELECT * FROM episodeState WHERE episodeId = :episodeId LIMIT 1") suspend fun stateFor(episodeId: String): EpisodeStateRow?
    @Query("SELECT * FROM episodeState WHERE episodeId IN (:ids) AND deleted = 0") suspend fun liveStates(ids: List<String>): List<EpisodeStateRow>
    @Query("SELECT * FROM episodeState WHERE deleted = 0") suspend fun allLiveStates(): List<EpisodeStateRow>
    @Query("SELECT * FROM episodeState WHERE id IN (:ids)") suspend fun statesByIds(ids: List<String>): List<EpisodeStateRow>
    @Query("SELECT * FROM episodeState WHERE episodeId = :nk") suspend fun statesByNaturalKey(nk: String): List<EpisodeStateRow>
    @Query("DELETE FROM episodeState WHERE id = :id") suspend fun deleteState(id: String)
    @Query("DELETE FROM episodeState WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'episodeStates')") suspend fun clearCleanStates()

    // ---- subscriptions
    @Upsert suspend fun upsertSubscription(s: SubscriptionRow)
    @Query("SELECT * FROM subscription WHERE podcastId = :podcastId AND deleted = 0 LIMIT 1") suspend fun liveSubscription(podcastId: String): SubscriptionRow?
    @Query("SELECT * FROM subscription WHERE podcastId = :podcastId LIMIT 1") suspend fun anySubscription(podcastId: String): SubscriptionRow?
    @Query("SELECT * FROM subscription WHERE deleted = 0") suspend fun liveSubscriptions(): List<SubscriptionRow>
    @Query("SELECT * FROM subscription WHERE id IN (:ids)") suspend fun subscriptionsByIds(ids: List<String>): List<SubscriptionRow>
    @Query("SELECT * FROM subscription WHERE id = :id") suspend fun subscriptionById(id: String): SubscriptionRow?
    @Query("SELECT * FROM subscription WHERE podcastId = :nk") suspend fun subscriptionsByNaturalKey(nk: String): List<SubscriptionRow>
    @Query("DELETE FROM subscription WHERE id = :id") suspend fun deleteSubscription(id: String)
    @Query("DELETE FROM subscription WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'subscriptions')") suspend fun clearCleanSubscriptions()

    // ---- bookmarks
    @Upsert suspend fun upsertBookmark(b: BookmarkRow)
    @Query("SELECT * FROM bookmark WHERE id = :id") suspend fun bookmarkById(id: String): BookmarkRow?
    @Query("SELECT * FROM bookmark WHERE id IN (:ids)") suspend fun bookmarksByIds(ids: List<String>): List<BookmarkRow>
    @Query("SELECT * FROM bookmark WHERE deleted = 0 ORDER BY createdAt DESC, id") suspend fun liveBookmarks(): List<BookmarkRow>
    @Query("SELECT COUNT(*) FROM bookmark WHERE deleted = 0") suspend fun bookmarkCount(): Int
    @Query("SELECT * FROM bookmark WHERE episodeId = :episodeId AND deleted = 0 ORDER BY positionMs, id") suspend fun bookmarksFor(episodeId: String): List<BookmarkRow>
    @Query("DELETE FROM bookmark WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'bookmarks')") suspend fun clearCleanBookmarks()

    // ---- playlists
    @Upsert suspend fun upsertPlaylist(p: PlaylistRow)
    @Query("SELECT * FROM playlist WHERE id = :id") suspend fun playlistById(id: String): PlaylistRow?
    @Query("SELECT * FROM playlist WHERE id IN (:ids)") suspend fun playlistsByIds(ids: List<String>): List<PlaylistRow>
    @Query("SELECT * FROM playlist WHERE deleted = 0 AND name != '__upnext__' ORDER BY name COLLATE NOCASE, id") suspend fun livePlaylists(): List<PlaylistRow>
    @Query("DELETE FROM playlist WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'playlists')") suspend fun clearCleanPlaylists()

    // ---- smart playlists
    @Upsert suspend fun upsertSmartPlaylist(p: SmartPlaylistRow)
    @Query("SELECT * FROM smartPlaylist WHERE id = :id") suspend fun smartPlaylistById(id: String): SmartPlaylistRow?
    @Query("SELECT * FROM smartPlaylist WHERE id IN (:ids)") suspend fun smartPlaylistsByIds(ids: List<String>): List<SmartPlaylistRow>
    @Query("SELECT * FROM smartPlaylist WHERE deleted = 0 ORDER BY name COLLATE NOCASE, id") suspend fun liveSmartPlaylists(): List<SmartPlaylistRow>
    @Query("DELETE FROM smartPlaylist WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'smartPlaylists')") suspend fun clearCleanSmartPlaylists()

    // ---- settings
    @Upsert suspend fun upsertSettings(s: SettingsRow)
    @Query("SELECT * FROM settings WHERE id = :id") suspend fun settingsById(id: String): SettingsRow?
    @Query("SELECT * FROM settings WHERE id IN (:ids)") suspend fun settingsByIds(ids: List<String>): List<SettingsRow>
    @Query("DELETE FROM settings WHERE id NOT IN (SELECT recordId FROM outbox WHERE collection = 'settings')") suspend fun clearCleanSettings()

    // ---- transcripts
    @Upsert suspend fun upsertTranscript(t: TranscriptRow)
    @Query("SELECT * FROM transcript WHERE episodeId = :id") suspend fun transcript(id: String): TranscriptRow?

    // ---- downloads
    @Upsert suspend fun upsertDownload(d: DownloadRow)
    @Query("SELECT * FROM download ORDER BY `at` DESC") suspend fun allDownloads(): List<DownloadRow>
    @Query("SELECT * FROM download WHERE episodeId = :id") suspend fun download(id: String): DownloadRow?
    @Query("SELECT episodeId FROM download WHERE episodeId IN (:ids)") suspend fun downloadedIn(ids: List<String>): List<String>
    @Query("SELECT episodeId FROM download") suspend fun downloadedIds(): List<String>
    @Query("DELETE FROM download WHERE episodeId = :id") suspend fun deleteDownload(id: String)
    @Query("SELECT COALESCE(SUM(bytes), 0) FROM download") suspend fun downloadedBytes(): Long

    // ---- outbox
    @Upsert suspend fun enqueueOutbox(o: OutboxRow)
    @Query("SELECT recordId FROM outbox WHERE collection = :collection LIMIT :limit") suspend fun outboxIds(collection: String, limit: Int): List<String>
    @Query("SELECT recordId FROM outbox WHERE collection = :collection") suspend fun allOutboxIds(collection: String): List<String>
    @Query("DELETE FROM outbox WHERE collection = :collection AND recordId = :id") suspend fun deleteOutbox(collection: String, id: String)
    @Query("SELECT COUNT(*) FROM outbox") suspend fun outboxCount(): Int

    // ---- kv
    @Upsert suspend fun upsertKv(k: KvRow)
    @Query("SELECT value FROM kv WHERE `key` = :key") suspend fun kvGet(key: String): String?
    @Query("DELETE FROM kv WHERE `key` = :key") suspend fun kvDelete(key: String)
}

@Database(
    entities = [
        PodcastRow::class, EpisodeRow::class, SubscriptionRow::class, EpisodeStateRow::class, BookmarkRow::class,
        PlaylistRow::class, SmartPlaylistRow::class, SettingsRow::class, TranscriptRow::class, DownloadRow::class,
        OutboxRow::class, KvRow::class,
    ],
    version = 1,
    exportSchema = false,
)
@TypeConverters(Converters::class)
abstract class AppDb : RoomDatabase() {
    abstract fun dao(): HcDao

    companion object {
        fun open(context: Context, userId: String): AppDb =
            Room.databaseBuilder(context.applicationContext, AppDb::class.java, "homecast-$userId.db")
                .fallbackToDestructiveMigration(true)
                .build()

        fun inMemory(context: Context): AppDb =
            Room.inMemoryDatabaseBuilder(context, AppDb::class.java).allowMainThreadQueries().build()
    }
}
