package app.homecast.core

import app.homecast.contract.*
import app.homecast.core.net.ApiClient
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import java.net.URLEncoder

class RemoteImpl(private val api: ApiClient, private val library: Library) : Remote {

    private fun JsonElement?.obj(): JsonObject = this as? JsonObject ?: throw ApiException(0, "Unexpected response from the server.", "decode")
    private fun parse(s: String): JsonObject = try { HcJson.parseToJsonElement(s).obj() } catch (e: ApiException) { throw e } catch (e: Exception) { throw ApiException(0, "Unexpected response from the server.", "decode") }
    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.num(k: String) = this[k]?.jsonPrimitive?.doubleOrNull

    override suspend fun discover(query: String?, sort: String): List<DiscoverItem> {
        val q = query?.trim()?.takeIf { it.isNotEmpty() }?.let { "&q=" + URLEncoder.encode(it.take(100), "UTF-8") } ?: ""
        val o = parse(api.get("/discover?sort=$sort&limit=100$q").body)
        return (o["items"] as? JsonArray).orEmpty().map { e ->
            val i = e.obj()
            DiscoverItem(
                id = i.str("id") ?: "", title = i.str("title") ?: "", author = i.str("author") ?: "", imageUrl = i.str("imageUrl"),
                description = i.str("description") ?: "", subscriberCount = i.num("subscriberCount")?.toInt() ?: 0, addedAt = i.num("addedAt")?.toLong() ?: 0,
            )
        }
    }

    override suspend fun subscribe(podcastId: String) {
        api.postJson("/subscriptions", buildJsonObject { put("podcastId", podcastId) })
    }

    override suspend fun addPodcast(feedUrl: String, private: Boolean): Pair<String, String> {
        val o = parse(api.postJson("/podcasts", buildJsonObject { put("feedUrl", feedUrl.trim()); put("private", private) }).body)
        val p = o["podcast"].obj()
        return (p.str("id") ?: "") to (p.str("title") ?: "")
    }

    override suspend fun importOpml(opml: String): OpmlResult {
        val o = parse(api.postText("/opml/import", opml, "text/x-opml").body)
        return OpmlResult(o.num("imported")?.toInt() ?: 0, (o["failed"] as? JsonArray)?.size ?: 0)
    }

    override suspend fun exportOpml(): String = api.get("/opml/export").body
    override suspend fun exportData(): String = api.get("/me/export").body

    override suspend fun sessions(): List<SessionInfo> {
        val o = parse(api.get("/auth/sessions").body)
        return (o["sessions"] as? JsonArray).orEmpty().map { e ->
            val s = e.obj()
            SessionInfo(s.str("id") ?: "", s.str("deviceName") ?: "", s.num("createdAt")?.toLong() ?: 0, s.num("lastUsedAt")?.toLong() ?: 0, s["current"]?.jsonPrimitive?.booleanOrNull ?: false)
        }
    }

    override suspend fun revokeSession(id: String) { api.delete("/auth/sessions/${URLEncoder.encode(id, "UTF-8")}") }

    override suspend fun changePassword(current: String, new: String) {
        api.postJson("/auth/change-password", buildJsonObject { put("currentPassword", current); put("newPassword", new) })
    }

    // ---- transcripts (spec §3.8): cached locally for offline reading

    override suspend fun loadTranscript(episodeId: String): TranscriptStatus {
        library.transcript(episodeId)?.let { return TranscriptStatus.Ready(it) }
        return try {
            absorb(episodeId, api.get("/episodes/$episodeId/transcript").body)
        } catch (e: ApiException) { TranscriptStatus.None }
        catch (e: OfflineException) { TranscriptStatus.Offline }
    }

    override suspend fun requestTranscript(episodeId: String): TranscriptStatus = try {
        absorb(episodeId, api.postJson("/episodes/$episodeId/transcript").body)
    } catch (e: ApiException) { TranscriptStatus.None }
    catch (e: OfflineException) { TranscriptStatus.Offline }

    // ---- episode hosting: stream the server's own copy through a signed URL

    override suspend fun streamUrl(episodeId: String): String? = try {
        withTimeoutOrNull(4_000) { parse(api.get("/episodes/$episodeId/stream").body).str("url")?.let { api.resolve(it) } }
    } catch (e: ApiException) { null }
    catch (e: OfflineException) { null }

    private suspend fun absorb(episodeId: String, body: String): TranscriptStatus {
        val o = parse(body)
        val segs = o["segments"] as? JsonArray
        if (o.str("status") == "ready" && segs != null) {
            val list = segs.map { s -> val j = s.obj(); TranscriptSegment(j.num("startMs")?.toLong() ?: 0, j.num("endMs")?.toLong() ?: 0, j.str("text") ?: "") }
            val t = Transcript(episodeId, o.str("source") ?: "whisper", o.str("model"), list)
            library.saveTranscript(t)
            return TranscriptStatus.Ready(t)
        }
        val job = o["job"] as? JsonObject
        if (job == null && o.str("status") !in setOf("queued", "running")) return TranscriptStatus.None
        return TranscriptStatus.Pending(job?.str("stage"), job?.num("progress"), job?.num("queuePosition")?.toInt())
    }
}
