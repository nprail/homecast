package app.homecast.core.sync

import androidx.room.withTransaction
import app.homecast.contract.ApiException
import app.homecast.core.HcJson
import app.homecast.core.RecordID
import app.homecast.core.db.*
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.*

/** One synced per-user collection: wire (de)serialisation plus the DAO operations the generic merge needs. */
internal abstract class Coll<R : Any>(val name: String, private val ser: KSerializer<R>) {
    abstract fun id(r: R): String
    abstract fun updatedAt(r: R): Long
    abstract suspend fun byIds(d: HcDao, ids: List<String>): List<R>
    abstract suspend fun get(d: HcDao, id: String): R?
    abstract suspend fun save(d: HcDao, r: R)
    abstract suspend fun delete(d: HcDao, id: String)
    /** Rows with the same natural key (one row per user+episode / user+podcast), or null if the collection has none. */
    open suspend fun sameNaturalKey(d: HcDao, r: R): List<R>? = null
    abstract suspend fun clearClean(d: HcDao)

    fun encode(rows: List<R>): JsonArray = JsonArray(rows.map { HcJson.encodeToJsonElement(ser, it) })
    fun decode(a: JsonElement?): List<R> = (a as? JsonArray).orEmpty().map { HcJson.decodeFromJsonElement(ser, it) }
}

internal object Colls {
    val states = object : Coll<EpisodeStateRow>("episodeStates", EpisodeStateRow.serializer()) {
        override fun id(r: EpisodeStateRow) = r.id
        override fun updatedAt(r: EpisodeStateRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.statesByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.stateById(id)
        override suspend fun save(d: HcDao, r: EpisodeStateRow) = d.upsertState(r)
        override suspend fun delete(d: HcDao, id: String) = d.deleteState(id)
        override suspend fun sameNaturalKey(d: HcDao, r: EpisodeStateRow) = d.statesByNaturalKey(r.episodeId)
        override suspend fun clearClean(d: HcDao) = d.clearCleanStates()
    }
    val bookmarks = object : Coll<BookmarkRow>("bookmarks", BookmarkRow.serializer()) {
        override fun id(r: BookmarkRow) = r.id
        override fun updatedAt(r: BookmarkRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.bookmarksByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.bookmarkById(id)
        override suspend fun save(d: HcDao, r: BookmarkRow) = d.upsertBookmark(r)
        override suspend fun delete(d: HcDao, id: String) {}
        override suspend fun clearClean(d: HcDao) = d.clearCleanBookmarks()
    }
    val playlists = object : Coll<PlaylistRow>("playlists", PlaylistRow.serializer()) {
        override fun id(r: PlaylistRow) = r.id
        override fun updatedAt(r: PlaylistRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.playlistsByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.playlistById(id)
        override suspend fun save(d: HcDao, r: PlaylistRow) = d.upsertPlaylist(r)
        override suspend fun delete(d: HcDao, id: String) {}
        override suspend fun clearClean(d: HcDao) = d.clearCleanPlaylists()
    }
    val smartPlaylists = object : Coll<SmartPlaylistRow>("smartPlaylists", SmartPlaylistRow.serializer()) {
        override fun id(r: SmartPlaylistRow) = r.id
        override fun updatedAt(r: SmartPlaylistRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.smartPlaylistsByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.smartPlaylistById(id)
        override suspend fun save(d: HcDao, r: SmartPlaylistRow) = d.upsertSmartPlaylist(r)
        override suspend fun delete(d: HcDao, id: String) {}
        override suspend fun clearClean(d: HcDao) = d.clearCleanSmartPlaylists()
    }
    val settings = object : Coll<SettingsRow>("settings", SettingsRow.serializer()) {
        override fun id(r: SettingsRow) = r.id
        override fun updatedAt(r: SettingsRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.settingsByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.settingsById(id)
        override suspend fun save(d: HcDao, r: SettingsRow) = d.upsertSettings(r)
        override suspend fun delete(d: HcDao, id: String) {}
        override suspend fun clearClean(d: HcDao) = d.clearCleanSettings()
    }
    val subscriptions = object : Coll<SubscriptionRow>("subscriptions", SubscriptionRow.serializer()) {
        override fun id(r: SubscriptionRow) = r.id
        override fun updatedAt(r: SubscriptionRow) = r.clientUpdatedAt
        override suspend fun byIds(d: HcDao, ids: List<String>) = d.subscriptionsByIds(ids)
        override suspend fun get(d: HcDao, id: String) = d.subscriptionById(id)
        override suspend fun save(d: HcDao, r: SubscriptionRow) = d.upsertSubscription(r)
        override suspend fun delete(d: HcDao, id: String) = d.deleteSubscription(id)
        override suspend fun sameNaturalKey(d: HcDao, r: SubscriptionRow) = d.subscriptionsByNaturalKey(r.podcastId)
        override suspend fun clearClean(d: HcDao) = d.clearCleanSubscriptions()
    }
    val all: List<Coll<*>> = listOf(states, bookmarks, playlists, smartPlaylists, settings, subscriptions)
}

private data class Sent(val collection: String, val id: String, val clientUpdatedAt: Long)

/**
 * Delta sync (spec §5): push outbox records, pull everything after `cursor`, repeat while `hasMore`.
 * Conflicts are resolved server-side (last-write-wins); locally a pending change newer than an incoming record is kept.
 * [transport] posts the JSON request body to `/sync` and returns the JSON response (throwing OfflineException/ApiException).
 */
class SyncCore(private val db: AppDb, private val transport: suspend (String) -> String) {
    private val dao get() = db.dao()

    suspend fun kvInt(key: String): Long = dao.kvGet(key)?.toLongOrNull() ?: 0

    private suspend fun deviceId(): String =
        dao.kvGet("deviceId") ?: RecordID.new().also { dao.upsertKv(KvRow("deviceId", it)) }

    /** Runs the push/pull loop until the outbox is drained and nothing more is pending (at most 50 rounds). */
    suspend fun run() {
        val device = deviceId()
        for (round in 0 until 50) {
            val cursor = kvInt("cursor")
            val (request, sent) = db.withTransaction { buildRequest(cursor, device) }
            val text = transport(request)
            val res = try { HcJson.parseToJsonElement(text).jsonObject } catch (e: Exception) { throw ApiException(0, "Unexpected response from the server.", "decode") }
            val fullResync = res["fullResync"]?.jsonPrimitive?.booleanOrNull == true
            val hasMore = res["hasMore"]?.jsonPrimitive?.booleanOrNull == true
            val newCursor = res["cursor"]?.jsonPrimitive?.longOrNull ?: cursor
            db.withTransaction {
                if (fullResync) resetSynced()
                merge(res, sent)
                dao.upsertKv(KvRow("cursor", newCursor.toString()))
            }
            val dirty = dao.outboxCount()
            if (!hasMore && !fullResync && dirty == 0) break
            if (!hasMore && !fullResync && dirty > 0 && round > 3) break
        }
    }

    // ---- collect / merge ------------------------------------------------------------------------------------------

    private suspend fun <R : Any> load(c: Coll<R>, sent: MutableList<Sent>): JsonArray {
        val ids = dao.outboxIds(c.name, 2000)
        val rows = ids.chunked(500).flatMap { c.byIds(dao, it) }
        rows.forEach { sent += Sent(c.name, c.id(it), c.updatedAt(it)) }
        // Outbox entries whose row vanished are stale: drop them.
        val have = rows.map { c.id(it) }.toSet()
        for (id in ids) if (id !in have) dao.deleteOutbox(c.name, id)
        return c.encode(rows)
    }

    private suspend fun buildRequest(cursor: Long, device: String): Pair<String, List<Sent>> {
        val sent = mutableListOf<Sent>()
        val changes = buildJsonObject { for (c in Colls.all) put(c.name, load(c, sent)) }
        val body = buildJsonObject { put("cursor", cursor); put("deviceId", device); put("changes", changes) }
        return body.toString() to sent
    }

    private suspend fun resetSynced() {
        dao.deleteAllPodcasts(); dao.deleteAllEpisodes()
        for (c in Colls.all) c.clearClean(dao)
    }

    private suspend fun merge(res: JsonObject, sent: List<Sent>) {
        val changes = res["changes"] as? JsonObject ?: JsonObject(emptyMap())
        for (el in changes["podcasts"] as? JsonArray ?: JsonArray(emptyList())) {
            val o = el.jsonObject
            if (o["deleted"]?.jsonPrimitive?.booleanOrNull == true) dao.deletePodcast(o["id"]!!.jsonPrimitive.content)
            else dao.upsertPodcast(HcJson.decodeFromJsonElement(PodcastRow.serializer(), o))
        }
        for (el in changes["episodes"] as? JsonArray ?: JsonArray(emptyList())) {
            val o = el.jsonObject
            if (o["deleted"]?.jsonPrimitive?.booleanOrNull == true) dao.deleteEpisode(o["id"]!!.jsonPrimitive.content)
            else dao.upsertEpisode(HcJson.decodeFromJsonElement(EpisodeRow.serializer(), o))
        }
        val rejected = (res["rejected"] as? JsonArray).orEmpty().mapNotNull {
            val o = it as? JsonObject ?: return@mapNotNull null
            "${o["collection"]?.jsonPrimitive?.contentOrNull}:${o["id"]?.jsonPrimitive?.contentOrNull}"
        }.toSet()
        for (c in Colls.all) mergeUser(c, changes[c.name])
        for (c in Colls.all) ack(c, sent, rejected)
    }

    private suspend fun <R : Any> mergeUser(c: Coll<R>, json: JsonElement?) {
        val incoming = c.decode(json)
        if (incoming.isEmpty()) return
        val outbox = dao.allOutboxIds(c.name).toHashSet()
        for (rec in incoming) {
            val rid = c.id(rec)
            if (rid in outbox) {
                val local = c.get(dao, rid)
                if (local != null && c.updatedAt(local) > c.updatedAt(rec)) continue
            }
            // A different local id for the same natural key means the server kept its own row: adopt it.
            c.sameNaturalKey(dao, rec)?.forEach { dup -> if (c.id(dup) != rid && c.id(dup) !in outbox) c.delete(dao, c.id(dup)) }
            c.save(dao, rec)
            dao.deleteOutbox(c.name, rid)
        }
    }

    /** Acknowledge what we sent: rejected ids would be re-sent forever, and unchanged rows are now on the server. */
    private suspend fun <R : Any> ack(c: Coll<R>, sent: List<Sent>, rejected: Set<String>) {
        for (s in sent) {
            if (s.collection != c.name) continue
            if ("${s.collection}:${s.id}" in rejected) { dao.deleteOutbox(c.name, s.id); continue }
            val cur = c.get(dao, s.id)
            if (cur != null && c.updatedAt(cur) == s.clientUpdatedAt) dao.deleteOutbox(c.name, s.id)
        }
    }
}
