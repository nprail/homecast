package app.homecast.core.db

import app.homecast.contract.*
import kotlinx.serialization.json.*

fun PodcastRow.toModel() = Podcast(id, feedUrl, isPrivate, title, author, imageUrl, summary)
fun EpisodeRow.toModel() = Episode(id, podcastId, guid, title, summary, audioUrl, mimeType, durationSec, releasedAt, hasPublisherTranscript ?: false)
fun SubscriptionRow.toModel() = Subscription(
    id, podcastId, AutoDownload(AutoDownloadMode.fromWire(autoDownload.mode), autoDownload.count), newEpisodeNotify, clientUpdatedAt,
)
fun EpisodeStateRow.toModel() = EpisodeState(id, episodeId, PlayStatus.fromWire(status), positionMs, positionUpdatedAt, playedAt, starred, clientUpdatedAt)
fun BookmarkRow.toModel() = Bookmark(id, episodeId, positionMs, title, note, createdAt)
fun PlaylistRow.toModel() = Playlist(id, name, episodeIds)
fun DownloadRow.toModel() = DownloadRecord(episodeId, podcastId, bytes, at, fileName)
fun DownloadRecord.toRow() = DownloadRow(episodeId, podcastId, bytes, at, fileName)
fun TranscriptRow.toModel() = Transcript(episodeId, source, model, segments.map { TranscriptSegment(it.startMs, it.endMs, it.text) })
fun Transcript.toRow() = TranscriptRow(episodeId, source, model, segments.map { SegmentW(it.startMs, it.endMs, it.text) })

fun SettingsRow.cleanupDays(): Map<String, Int> =
    (prefs["cleanupDays"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.doubleOrNull?.let { k to it.toInt() } }?.toMap() ?: emptyMap()

fun SettingsRow.withCleanupDays(days: Map<String, Int>): SettingsRow =
    copy(prefs = prefs + ("cleanupDays" to JsonObject(days.mapValues { JsonPrimitive(it.value) })))

fun SettingsRow.toModel() = UserSettings(defaultSpeed, podcastSpeeds, cleanupDays())
