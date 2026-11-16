package app.homecast.core

import app.homecast.contract.*
import app.homecast.core.db.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The JSON we send must satisfy the server's zod schemas (shared/src/sync.ts); the JSON we get must decode directly. */
class WireFormatTest {
    private fun enc(el: JsonElement) = el.jsonObject

    @Test fun deterministicIdsMatchWebClient() {
        val u = "0273fd19-62cc-411d-9c77-9f1e249a7591"; val e = "e958e5b1-8949-4b3c-b847-4d569915eda6"
        assertEquals("0273fd1962cc411d9c779f1e249a7591e958e5b189494b3cb8474d569915eda6", RecordID.state(u, e))
        assertEquals(RecordID.state(u, e), RecordID.subscription(u, e))
        assertEquals("s0273fd1962cc411d9c779f1e249a7591", RecordID.settings(u))
        assertEquals("q0273fd1962cc411d9c779f1e249a7591", RecordID.upNext(u))
    }

    @Test fun episodeStateOmitsNullsAndSendsDeleted() {
        val row = EpisodeStateRow("a".repeat(64), "ep1234567", "inProgress", 1234, null, null, true, 99, false)
        val o = enc(HcJson.encodeToJsonElement(EpisodeStateRow.serializer(), row))
        assertFalse("positionUpdatedAt" in o); assertFalse("playedAt" in o)
        assertEquals(false, o["deleted"]!!.jsonPrimitive.boolean)
        assertEquals(setOf("id", "episodeId", "status", "positionMs", "starred", "clientUpdatedAt", "deleted"), o.keys)
        assertTrue(o["positionMs"]!!.jsonPrimitive.isString.not())
        assertEquals("inProgress", o["status"]!!.jsonPrimitive.content)
    }

    @Test fun subscriptionAndSettingsShape() {
        val sub = enc(HcJson.encodeToJsonElement(SubscriptionRow.serializer(), SubscriptionRow("id123456", "pod12345", AutoDownloadW("latest", 3), true, 5, true)))
        assertEquals("latest", sub["autoDownload"]!!.jsonObject["mode"]!!.jsonPrimitive.content)
        assertEquals(3, sub["autoDownload"]!!.jsonObject["count"]!!.jsonPrimitive.int)
        assertTrue(sub["deleted"]!!.jsonPrimitive.boolean)
        val off = enc(HcJson.encodeToJsonElement(AutoDownloadW.serializer(), AutoDownloadW()))
        assertEquals(setOf("mode"), off.keys) // count omitted, not null
        val s = enc(HcJson.encodeToJsonElement(SettingsRow.serializer(), SettingsRow("s1", 1.5, mapOf("p" to 2.0), mapOf("cleanupDays" to buildJsonObject { put("p", 7) }), 1)))
        assertEquals(1.5, s["defaultSpeed"]!!.jsonPrimitive.double, 0.0)
        assertEquals(7, s["prefs"]!!.jsonObject["cleanupDays"]!!.jsonObject["p"]!!.jsonPrimitive.int)
    }

    @Test fun bookmarkPlaylistAndSmartPlaylistShape() {
        val b = enc(HcJson.encodeToJsonElement(BookmarkRow.serializer(), BookmarkRow("b1234567", "e1234567", 10, null, "note", 5, 5)))
        assertFalse("title" in b); assertEquals("note", b["note"]!!.jsonPrimitive.content)
        val p = enc(HcJson.encodeToJsonElement(PlaylistRow.serializer(), PlaylistRow("q1234567", "__upnext__", listOf("a", "b"), 5)))
        assertEquals(2, p["episodeIds"]!!.jsonArray.size)
        val sp = enc(HcJson.encodeToJsonElement(SmartPlaylistRow.serializer(), SmartPlaylistRow("s1234567", "n", SmartPlaylistDefinition("n", rules = listOf(SmartRule.Starred(true))), 5)))
        val def = sp["definition"]!!.jsonObject
        assertEquals("all", def["match"]!!.jsonPrimitive.content)
        assertFalse("limit" in def); assertFalse("autoDownload" in def)
    }

    @Test fun decodesServerRecords() {
        val st = HcJson.decodeFromString(EpisodeStateRow.serializer(), """{"id":"x","episodeId":"e","status":"played","positionMs":5,"clientUpdatedAt":7,"rev":42,"deleted":false,"userId":"u"}""")
        assertEquals("played", st.status); assertNull(st.positionUpdatedAt)
        val ep = HcJson.decodeFromString(EpisodeRow.serializer(), """{"id":"e","podcastId":"p","guid":"g","title":"T","description":"D","audioUrl":"http://a","mimeType":"audio/mpeg","durationSec":12.5,"releasedAt":1700000000000,"hasPublisherTranscript":null,"rev":3,"deleted":false}""")
        assertEquals("D", ep.summary); assertEquals(1700000000000, ep.releasedAt)
        val pod = HcJson.decodeFromString(PodcastRow.serializer(), """{"id":"p","feedUrl":"http://f","isPrivate":false,"title":"T","author":"A","imageUrl":null,"description":"S","rev":1}""")
        assertEquals("S", pod.summary); assertNull(pod.imageUrl)
        val set = HcJson.decodeFromString(SettingsRow.serializer(), """{"id":"s","defaultSpeed":1.2,"podcastSpeeds":{"p":1.5},"prefs":{"x":[1,2],"cleanupDays":{"p":3}},"clientUpdatedAt":1}""")
        assertEquals(3, set.cleanupDays()["p"])
        val sub = HcJson.decodeFromString(SubscriptionRow.serializer(), """{"id":"s","podcastId":"p","clientUpdatedAt":1}""")
        assertEquals("off", sub.autoDownload.mode); assertTrue(sub.newEpisodeNotify)
    }

    @Test fun urlNormalisation() {
        assertEquals("https://podcasts.example.com", normalizeServerUrl(" podcasts.example.com/ "))
        assertEquals("http://192.168.1.5:8080", normalizeServerUrl("http://192.168.1.5:8080//"))
        assertNull(normalizeServerUrl("   "))
        assertNull(normalizeServerUrl("https://"))
    }

    @Test fun playStatusMapping() {
        assertEquals(PlayStatus.InProgress, PlayStatus.fromWire("inProgress"))
        assertEquals(PlayStatus.Unplayed, PlayStatus.fromWire("weird"))
    }
}
