package app.homecast.contract

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

// ---- Domain models (mirror the server's sync records; see shared/src/sync.ts) -----------------------------------
// Timestamps are epoch milliseconds. Every user-scoped record is a plain immutable value; `Library` does the writes.

enum class PlayStatus(val wire: String) {
    Unplayed("unplayed"), InProgress("inProgress"), Played("played");
    companion object { fun fromWire(s: String?): PlayStatus = entries.firstOrNull { it.wire == s } ?: Unplayed }
}

data class Podcast(
    val id: String,
    val feedUrl: String,
    val isPrivate: Boolean,
    val title: String,
    val author: String,
    val imageUrl: String?,
    val summary: String,
)

data class Episode(
    val id: String,
    val podcastId: String,
    val guid: String,
    val title: String,
    val summary: String,
    val audioUrl: String,
    val mimeType: String,
    val durationSec: Double,
    val releasedAt: Long,
    val hasPublisherTranscript: Boolean,
)

enum class AutoDownloadMode(val wire: String) {
    Off("off"), Latest("latest"), All("all");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } ?: Off }
}
data class AutoDownload(val mode: AutoDownloadMode = AutoDownloadMode.Off, val count: Int? = null)

data class Subscription(
    val id: String,
    val podcastId: String,
    val autoDownload: AutoDownload = AutoDownload(),
    val newEpisodeNotify: Boolean = true,
    val clientUpdatedAt: Long = 0,
)

data class EpisodeState(
    val id: String,
    val episodeId: String,
    val status: PlayStatus = PlayStatus.Unplayed,
    val positionMs: Long = 0,
    val positionUpdatedAt: Long? = null,
    val playedAt: Long? = null,
    val starred: Boolean = false,
    val clientUpdatedAt: Long = 0,
)

data class Bookmark(
    val id: String,
    val episodeId: String,
    val positionMs: Long,
    val title: String?,
    val note: String?,
    val createdAt: Long,
)

data class Playlist(val id: String, val name: String, val episodeIds: List<String>)

data class UserSettings(
    val defaultSpeed: Double = 1.0,
    val podcastSpeeds: Map<String, Double> = emptyMap(),
    /** "Delete played downloads after N days", per podcast (spec §3.5). Stored in synced `prefs.cleanupDays`. */
    val cleanupDays: Map<String, Int> = emptyMap(),
)

data class TranscriptSegment(val startMs: Long, val endMs: Long, val text: String)
data class Transcript(val episodeId: String, val source: String, val model: String?, val segments: List<TranscriptSegment>)

data class DownloadRecord(val episodeId: String, val podcastId: String, val bytes: Long, val at: Long, val fileName: String)

data class User(val id: String, val username: String, val role: String) { val isAdmin get() = role == "admin" }

/** An episode with everything a list row needs. */
data class EpisodeItem(
    val episode: Episode,
    val podcast: Podcast?,
    val state: EpisodeState?,
    val downloaded: Boolean,
) {
    val id get() = episode.id
    val status get() = state?.status ?: PlayStatus.Unplayed
    val starred get() = state?.starred ?: false
    val positionMs get() = state?.positionMs ?: 0L
    /** 0..1 of the episode already heard. */
    val progress: Float get() {
        if (episode.durationSec <= 0) return 0f
        if (status == PlayStatus.Played) return 1f
        return (positionMs / (episode.durationSec * 1000)).coerceIn(0.0, 1.0).toFloat()
    }
    val remainingSec: Double get() = maxOf(0.0, episode.durationSec - positionMs / 1000.0)
}

data class PlaylistWithItems(val playlist: Playlist, val items: List<EpisodeItem>)
data class SmartPlaylistSummary(val id: String, val definition: SmartPlaylistDefinition, val matchCount: Int)
data class SmartPlaylistWithItems(val id: String, val definition: SmartPlaylistDefinition, val items: List<EpisodeItem>)
data class BookmarkItem(val bookmark: Bookmark, val episode: Episode?, val podcast: Podcast?, val transcriptPreview: String?)

// ---- Smart playlists (spec §3.7), evaluated on-device ------------------------------------------------------------

@Serializable(with = SmartRuleSerializer::class)
sealed interface SmartRule {
    data class PodcastIn(val ids: List<String>) : SmartRule
    data class PodcastNotIn(val ids: List<String>) : SmartRule
    data class Status(val status: PlayStatus) : SmartRule
    data class ReleasedWithin(val days: Double) : SmartRule
    data class DurationLessThan(val minutes: Double) : SmartRule
    data class DurationGreaterThan(val minutes: Double) : SmartRule
    data class Downloaded(val value: Boolean) : SmartRule
    data class Starred(val value: Boolean) : SmartRule
    data class TitleContains(val text: String) : SmartRule
}

@Serializable enum class SmartMatch { @kotlinx.serialization.SerialName("all") All, @kotlinx.serialization.SerialName("any") Any }
@Serializable enum class SortField { @kotlinx.serialization.SerialName("releasedAt") ReleasedAt, @kotlinx.serialization.SerialName("duration") Duration, @kotlinx.serialization.SerialName("title") Title }
@Serializable enum class SortDir { @kotlinx.serialization.SerialName("asc") Asc, @kotlinx.serialization.SerialName("desc") Desc }
@Serializable data class SmartSort(val field: SortField, val dir: SortDir)

/** JSON-identical to the server's `smartPlaylistDefinitionSchema`. */
@Serializable
data class SmartPlaylistDefinition(
    val name: String,
    val match: SmartMatch = SmartMatch.All,
    val rules: List<SmartRule> = emptyList(),
    val sort: SmartSort = SmartSort(SortField.ReleasedAt, SortDir.Desc),
    val limit: Int? = null,
    val autoDownload: Boolean? = null,
) {
    companion object {
        fun blank(name: String = "New smart playlist") = SmartPlaylistDefinition(
            name, SmartMatch.All, listOf(SmartRule.Status(PlayStatus.Unplayed)), SmartSort(SortField.ReleasedAt, SortDir.Desc), 50, false,
        )
    }
}

/** The local-database view of an episode that rules are evaluated against. */
data class EpisodeView(
    val id: String,
    val podcastId: String,
    val title: String,
    val releasedAt: Long,
    val durationSec: Double,
    val status: PlayStatus,
    val downloaded: Boolean,
    val starred: Boolean,
)

object SmartRuleSerializer : KSerializer<SmartRule> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor
    override fun deserialize(decoder: Decoder): SmartRule {
        val o = (decoder as JsonDecoder).decodeJsonElement().jsonObject
        val field = o["field"]!!.jsonPrimitive.content
        val op = o["op"]?.jsonPrimitive?.content
        val v = o["value"]!!
        return when (field) {
            "podcast" -> { val ids = v.jsonArray.map { it.jsonPrimitive.content }; if (op == "notIn") SmartRule.PodcastNotIn(ids) else SmartRule.PodcastIn(ids) }
            "status" -> SmartRule.Status(PlayStatus.fromWire(v.jsonPrimitive.content))
            "releasedWithin" -> SmartRule.ReleasedWithin(v.jsonPrimitive.double)
            "duration" -> if (op == "gt") SmartRule.DurationGreaterThan(v.jsonPrimitive.double) else SmartRule.DurationLessThan(v.jsonPrimitive.double)
            "downloaded" -> SmartRule.Downloaded(v.jsonPrimitive.boolean)
            "starred" -> SmartRule.Starred(v.jsonPrimitive.boolean)
            "title" -> SmartRule.TitleContains(v.jsonPrimitive.content)
            else -> error("Unknown rule field $field")
        }
    }
    override fun serialize(encoder: Encoder, value: SmartRule) {
        fun rule(field: String, op: String, v: JsonElement) = buildJsonObject { put("field", field); put("op", op); put("value", v) }
        val e = when (value) {
            is SmartRule.PodcastIn -> rule("podcast", "in", JsonArray(value.ids.map(::JsonPrimitive)))
            is SmartRule.PodcastNotIn -> rule("podcast", "notIn", JsonArray(value.ids.map(::JsonPrimitive)))
            is SmartRule.Status -> rule("status", "is", JsonPrimitive(value.status.wire))
            is SmartRule.ReleasedWithin -> rule("releasedWithin", "days", JsonPrimitive(value.days))
            is SmartRule.DurationLessThan -> rule("duration", "lt", JsonPrimitive(value.minutes))
            is SmartRule.DurationGreaterThan -> rule("duration", "gt", JsonPrimitive(value.minutes))
            is SmartRule.Downloaded -> rule("downloaded", "is", JsonPrimitive(value.value))
            is SmartRule.Starred -> rule("starred", "is", JsonPrimitive(value.value))
            is SmartRule.TitleContains -> rule("title", "contains", JsonPrimitive(value.text))
        }
        (encoder as JsonEncoder).encodeJsonElement(e)
    }
}
