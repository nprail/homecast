package app.homecast.core.db

import androidx.room.Entity
import androidx.room.PrimaryKey
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import app.homecast.contract.SmartPlaylistDefinition

// Local-first rows (spec §4, §5). Synced rows mirror the server JSON field for field, so the same classes decode sync
// responses and persist to Room. A row is "dirty" while it has an outbox entry.

@Serializable @Entity(tableName = "podcast")
data class PodcastRow(
    @PrimaryKey val id: String,
    val feedUrl: String,
    val isPrivate: Boolean = false,
    val title: String,
    val author: String = "",
    val imageUrl: String? = null,
    @SerialName("description") val summary: String = "",
    val rev: Long? = null,
)

@Serializable @Entity(tableName = "episode", indices = [androidx.room.Index("podcastId"), androidx.room.Index("releasedAt")])
data class EpisodeRow(
    @PrimaryKey val id: String,
    val podcastId: String,
    val guid: String,
    val title: String,
    @SerialName("description") val summary: String = "",
    val audioUrl: String,
    val mimeType: String = "audio/mpeg",
    val durationSec: Double = 0.0,
    val releasedAt: Long,
    val hasPublisherTranscript: Boolean? = null,
    val rev: Long? = null,
)

@Serializable
data class AutoDownloadW(val mode: String = "off", val count: Int? = null)

@Serializable @Entity(tableName = "subscription", indices = [androidx.room.Index("podcastId")])
data class SubscriptionRow(
    @PrimaryKey val id: String,
    val podcastId: String,
    val autoDownload: AutoDownloadW = AutoDownloadW(),
    val newEpisodeNotify: Boolean = true,
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable @Entity(tableName = "episodeState", indices = [androidx.room.Index("episodeId")])
data class EpisodeStateRow(
    @PrimaryKey val id: String,
    val episodeId: String,
    val status: String = "unplayed",
    val positionMs: Long = 0,
    val positionUpdatedAt: Long? = null,
    val playedAt: Long? = null,
    val starred: Boolean = false,
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable @Entity(tableName = "bookmark", indices = [androidx.room.Index("episodeId")])
data class BookmarkRow(
    @PrimaryKey val id: String,
    val episodeId: String,
    val positionMs: Long = 0,
    val title: String? = null,
    val note: String? = null,
    val createdAt: Long = 0,
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable @Entity(tableName = "playlist")
data class PlaylistRow(
    @PrimaryKey val id: String,
    val name: String,
    val episodeIds: List<String> = emptyList(),
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable @Entity(tableName = "smartPlaylist")
data class SmartPlaylistRow(
    @PrimaryKey val id: String,
    val name: String,
    val definition: SmartPlaylistDefinition,
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable @Entity(tableName = "settings")
data class SettingsRow(
    @PrimaryKey val id: String,
    val defaultSpeed: Double = 1.0,
    val podcastSpeeds: Map<String, Double> = emptyMap(),
    val prefs: Map<String, JsonElement> = emptyMap(),
    val clientUpdatedAt: Long = 0,
    val deleted: Boolean = false,
)

@Serializable
data class SegmentW(val startMs: Long, val endMs: Long, val text: String)

@Serializable @Entity(tableName = "transcript")
data class TranscriptRow(
    @PrimaryKey val episodeId: String,
    val source: String,
    val model: String? = null,
    val segments: List<SegmentW> = emptyList(),
)

@Entity(tableName = "download", indices = [androidx.room.Index("podcastId")])
data class DownloadRow(
    @PrimaryKey val episodeId: String,
    val podcastId: String,
    val bytes: Long,
    val at: Long,
    val fileName: String,
)

@Entity(tableName = "outbox", primaryKeys = ["collection", "recordId"])
data class OutboxRow(val collection: String, val recordId: String)

@Entity(tableName = "kv")
data class KvRow(@PrimaryKey val key: String, val value: String)

data class UnplayedCount(val podcastId: String, val n: Int)
