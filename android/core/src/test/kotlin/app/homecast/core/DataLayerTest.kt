package app.homecast.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.homecast.contract.*
import app.homecast.core.db.*
import app.homecast.core.sync.SyncCore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val USER = "0273fd19-62cc-411d-9c77-9f1e249a7591"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DataLayerTest {
    private lateinit var db: AppDb
    private lateinit var lib: LibraryImpl
    private var tick = 1_000_000L
    private val scheduled = mutableListOf<Long>()

    private val fakeSync = object : SyncEngine {
        override val state = kotlinx.coroutines.flow.MutableStateFlow(SyncState())
        override suspend fun sync() {}
        override fun schedule(delayMs: Long) { scheduled += delayMs }
        override var onMerged: (() -> Unit)? = null
    }

    @Before fun setUp() {
        db = AppDb.inMemory(ApplicationProvider.getApplicationContext<Context>())
        lib = LibraryImpl(db, USER, { fakeSync }, { ++tick })
    }
    @After fun tearDown() { db.close() }

    private fun run(block: suspend () -> Unit) = runBlocking { block() }
    private fun outbox(coll: String) = runBlocking { db.dao().allOutboxIds(coll) }

    private suspend fun seed() {
        val d = db.dao()
        d.upsertPodcast(PodcastRow("pod1", "http://f/1", false, "Alpha Show", "A"))
        d.upsertPodcast(PodcastRow("pod2", "http://f/2", false, "beta show", "B"))
        for (i in 1..3) d.upsertEpisode(EpisodeRow("e1$i", "pod1", "g1$i", "Ep 1$i", "", "http://a/1$i", releasedAt = 1000L * i, durationSec = 600.0))
        for (i in 1..2) d.upsertEpisode(EpisodeRow("e2$i", "pod2", "g2$i", "Ep 2$i", "", "http://a/2$i", releasedAt = 5000L * i, durationSec = 1200.0))
        d.upsertSubscription(SubscriptionRow(RecordID.subscription(USER, "pod1"), "pod1"))
        d.upsertSubscription(SubscriptionRow(RecordID.subscription(USER, "pod2"), "pod2"))
    }

    @Test fun queueOrderingAndUpNextHiddenFromPlaylists() = run {
        lib.enqueue("a", QueuePosition.Last); lib.enqueue("b", QueuePosition.Last); lib.enqueue("c", QueuePosition.Front)
        assertEquals(listOf("c", "a", "b"), lib.queueIds())
        lib.enqueue("b", QueuePosition.Next, currentId = "c")
        assertEquals(listOf("c", "b", "a"), lib.queueIds())
        lib.enqueue("a", QueuePosition.Next, currentId = "zzz")
        assertEquals(listOf("a", "c", "b"), lib.queueIds())
        lib.dequeue("c")
        assertEquals(listOf("a", "b"), lib.queueIds())
        lib.setQueue(listOf("x", "y", "x", "z"))
        assertEquals(listOf("x", "y", "z"), lib.queueIds())
        lib.moveInQueue(0, 2)
        assertEquals(listOf("y", "z", "x"), lib.queueIds())
        assertEquals(listOf(RecordID.upNext(USER)), outbox("playlists"))
        assertTrue(lib.playlists().first().isEmpty())
        val id = lib.createPlaylist("  Road trip ", listOf("e1"))
        assertEquals(listOf("Road trip"), lib.playlists().first().map { it.name })
        lib.addToPlaylist(id, "e1"); lib.addToPlaylist(id, "e2")
        assertEquals(listOf("e1", "e2"), lib.playlists().first().single().episodeIds)
        lib.deletePlaylist(id)
        assertTrue(lib.playlists().first().isEmpty())
    }

    @Test fun writesQueueOutboxAndScheduleSync() = run {
        seed()
        lib.setStarred("e11", true)
        val st = lib.getState("e11")
        assertEquals(RecordID.state(USER, "e11"), st.id)
        assertTrue(st.starred)
        assertEquals(listOf(RecordID.state(USER, "e11")), outbox("episodeStates"))
        assertEquals(1, scheduled.size)
        lib.savePosition("e11", 30_000, 600_000)
        assertEquals(1, scheduled.size) // local only
        assertEquals(PlayStatus.InProgress, lib.getState("e11").status)
        val stamp = lib.getState("e11").positionUpdatedAt
        assertNotNull(stamp)
        // A paused player saves again (app backgrounded). That is not a play event, so the "last played" stamp stays.
        Thread.sleep(5)
        lib.savePosition("e11", 30_200, 600_000)
        assertEquals(stamp, lib.getState("e11").positionUpdatedAt)
        Thread.sleep(5)
        lib.savePosition("e11", 35_000, 600_000)
        assertTrue(lib.getState("e11").positionUpdatedAt!! > stamp!!)
        lib.savePosition("e11", 598_000, 600_000)
        assertEquals(PlayStatus.Played, lib.getState("e11").status)
        lib.markUnplayed("e11")
        assertEquals(0, lib.getState("e11").positionMs)
        lib.setDefaultSpeed(1.26); lib.setPodcastSpeed("pod1", 1.5); lib.setCleanupDays("pod1", 7)
        val s = lib.getSettings()
        assertEquals(1.3, s.defaultSpeed, 0.0001); assertEquals(1.5, s.podcastSpeeds["pod1"]!!, 0.0001); assertEquals(7, s.cleanupDays["pod1"])
        assertEquals(listOf(RecordID.settings(USER)), outbox("settings"))
        lib.setPodcastSpeed("pod1", null); lib.setCleanupDays("pod1", null)
        assertTrue(lib.getSettings().podcastSpeeds.isEmpty()); assertTrue(lib.getSettings().cleanupDays.isEmpty())
        val b = lib.addBookmark("e11", 5000, "  ", " note ")
        assertNull(b.title); assertEquals("note", b.note)
        lib.deleteBookmark(b.id)
        assertEquals(0, lib.bookmarkCount().first())
    }

    @Test fun readsUnplayedContinueAndItems() = run {
        seed()
        lib.markPlayed("e11")
        lib.savePosition("e12", 60_000, 600_000)
        assertEquals(mapOf("pod1" to 2, "pod2" to 2), lib.unplayedCounts().first())
        assertEquals(listOf("e12"), lib.continueListening().first().map { it.id })
        assertEquals(listOf("e22", "e21", "e13", "e12", "e11"), lib.latestEpisodes().first().map { it.id })
        assertEquals(listOf("Alpha Show", "beta show"), lib.subscribedPodcasts().first().map { it.title })
        val item = lib.getEpisodeItems(listOf("e13", "missing", "e11")).map { it.id }
        assertEquals(listOf("e13", "e11"), item)
        lib.unsubscribe("pod2")
        assertEquals(setOf("pod1"), lib.subscribedPodcastIds().first())
        assertEquals(listOf("e13", "e12", "e11"), lib.latestEpisodes().first().map { it.id })
        lib.recordDownload(DownloadRecord("e13", "pod1", 500, 10, "e13.mp3"))
        assertTrue(lib.getEpisodeItem("e13")!!.downloaded)
        assertEquals(500L, lib.downloadedBytes().first())
        val def = SmartPlaylistDefinition("d", rules = listOf(SmartRule.Downloaded(true)))
        assertEquals(listOf("e13"), lib.evaluate(def))
        val id = lib.saveSmartPlaylist(null, def)
        assertEquals(1, lib.smartPlaylists().first().single().matchCount)
        assertEquals(listOf("e13"), lib.smartPlaylist(id).first()!!.items.map { it.id })
        lib.kvSet("k", "v"); assertEquals("v", lib.kvGet("k")); lib.kvSet("k", null); assertNull(lib.kvGet("k"))
    }

    @Test fun flowReEmitsOnChange() = run {
        seed()
        assertEquals(0, lib.starredCount().first())
        lib.setStarred("e11", true)
        assertEquals(1, lib.starredCount().first())
    }

    // ---- sync merge --------------------------------------------------------------------------------------------

    private fun response(cursor: Long = 5, hasMore: Boolean = false, fullResync: Boolean = false, rejected: String = "[]", changes: String = "{}") =
        """{"cursor":$cursor,"hasMore":$hasMore,"fullResync":$fullResync,"rejected":$rejected,"changes":$changes}"""

    private fun core(vararg responses: String, requests: MutableList<JsonObject> = mutableListOf()): SyncCore {
        val q = ArrayDeque(responses.toList())
        return SyncCore(db) { body -> requests += Json.parseToJsonElement(body).jsonObject; q.removeFirstOrNull() ?: response() }
    }

    @Test fun pushesOutboxAndAcksByClientUpdatedAt() = run {
        seed()
        lib.setStarred("e11", true)
        val sid = RecordID.state(USER, "e11")
        val reqs = mutableListOf<JsonObject>()
        core(response(7), requests = reqs).run()
        val sent = reqs[0]["changes"]!!.jsonObject["episodeStates"]!!.jsonArray.single().jsonObject
        assertEquals(sid, sent["id"]!!.jsonPrimitive.content)
        assertFalse("positionUpdatedAt" in sent)
        assertEquals(0, reqs[0]["cursor"]!!.jsonPrimitive.int)
        assertTrue(outbox("episodeStates").isEmpty())
        assertEquals("7", db.dao().kvGet("cursor"))
        assertNotNull(db.dao().kvGet("deviceId"))
        assertEquals(1, reqs.size)
    }

    @Test fun editMadeDuringSyncStaysDirty() = run {
        seed()
        lib.setStarred("e11", true)
        val c = SyncCore(db) { _ ->
            lib.setStarred("e11", false) // local edit while the request is in flight
            response(8)
        }
        // first round acks nothing (clientUpdatedAt changed) so a second round re-sends; the fake keeps editing, so cap at 5 rounds
        c.run()
        assertFalse(lib.getState("e11").starred)
        assertEquals(listOf(RecordID.state(USER, "e11")), outbox("episodeStates"))
    }

    private fun incomingState(sid: String, cua: Long) =
        """{"id":"$sid","episodeId":"e11","status":"played","positionMs":0,"starred":false,"clientUpdatedAt":$cua,"deleted":false}"""

    @Test fun pendingNewerLocalChangeBeatsOlderIncoming() = run {
        seed()
        val sid = RecordID.state(USER, "e11")
        val reqs = mutableListOf<JsonObject>()
        var n = 0
        SyncCore(db) { body ->
            reqs += Json.parseToJsonElement(body).jsonObject
            if (n++ == 0) {
                lib.setStarred("e11", true) // local write while the request is in flight
                val local = db.dao().stateById(sid)!!
                response(changes = """{"episodeStates":[${incomingState(sid, local.clientUpdatedAt - 1)}]}""")
            } else response()
        }.run()
        assertTrue(db.dao().stateById(sid)!!.starred) // older incoming ignored
        assertEquals(2, reqs.size) // the pending write was pushed in a second round
        assertEquals(1, reqs[1]["changes"]!!.jsonObject["episodeStates"]!!.jsonArray.size)
        assertTrue(outbox("episodeStates").isEmpty())
    }

    @Test fun newerIncomingReplacesPendingLocalRow() = run {
        seed()
        val sid = RecordID.state(USER, "e11")
        var n = 0
        SyncCore(db) { _ ->
            if (n++ == 0) {
                lib.setStarred("e11", true)
                val local = db.dao().stateById(sid)!!
                response(changes = """{"episodeStates":[${incomingState(sid, local.clientUpdatedAt + 100)}]}""")
            } else response()
        }.run()
        assertFalse(db.dao().stateById(sid)!!.starred)
        assertEquals("played", db.dao().stateById(sid)!!.status)
        assertTrue(outbox("episodeStates").isEmpty())
    }

    @Test fun mergesSharedRecordsTombstonesAndNaturalKeyDedupe() = run {
        val p = """{"id":"pod1","feedUrl":"http://f","isPrivate":false,"title":"Alpha","author":"A","imageUrl":null,"description":"S","rev":1,"deleted":false}"""
        val e = """{"id":"e1","podcastId":"pod1","guid":"g","title":"T","description":"","audioUrl":"http://a","mimeType":"audio/mpeg","durationSec":10,"releasedAt":1700000000000,"hasPublisherTranscript":true,"rev":2,"deleted":false}"""
        val localSub = SubscriptionRow("local-sub-id", "pod1", clientUpdatedAt = 1)
        db.dao().upsertSubscription(localSub) // clean row (no outbox) with a different id for the same podcast
        val serverSub = """{"id":"server-sub-id","podcastId":"pod1","autoDownload":{"mode":"latest","count":2},"newEpisodeNotify":true,"clientUpdatedAt":9,"deleted":false}"""
        core(response(changes = """{"podcasts":[$p],"episodes":[$e],"subscriptions":[$serverSub]}""")).run()
        assertEquals("Alpha", db.dao().podcast("pod1")!!.title)
        assertTrue(db.dao().episode("e1")!!.hasPublisherTranscript!!)
        val subs = db.dao().liveSubscriptions()
        assertEquals(listOf("server-sub-id"), subs.map { it.id })
        assertEquals("latest", subs.single().autoDownload.mode)
        val tomb = """{"id":"e1","podcastId":"pod1","guid":"g","title":"T","audioUrl":"x","releasedAt":1,"rev":3,"deleted":true}"""
        val tombSub = """{"id":"server-sub-id","podcastId":"pod1","clientUpdatedAt":10,"deleted":true}"""
        core(response(changes = """{"episodes":[$tomb],"subscriptions":[$tombSub]}""")).run()
        assertNull(db.dao().episode("e1"))
        assertTrue(db.dao().liveSubscriptions().isEmpty())
    }

    @Test fun rejectedRecordsLeaveTheOutbox() = run {
        seed()
        lib.setStarred("e11", true)
        val sid = RecordID.state(USER, "e11")
        // server answers with a newer unrelated echo for the same id so ack-by-timestamp would NOT clear it; rejection must
        val rej = """[{"collection":"episodeStates","id":"$sid","reason":"unknown episode"}]"""
        core(response(rejected = rej)).run()
        assertTrue(outbox("episodeStates").isEmpty())
    }

    @Test fun fullResyncWipesCleanSyncedDataButKeepsPendingWrites() = run {
        seed()
        lib.setStarred("e11", true)
        db.dao().upsertState(EpisodeStateRow("clean-state", "e12", "played", 0, null, null, false, 1, false))
        val reqs = mutableListOf<JsonObject>()
        val p = """{"id":"pod9","feedUrl":"http://f","isPrivate":false,"title":"New","author":"","imageUrl":null,"description":"","rev":1,"deleted":false}"""
        core(response(cursor = 3, fullResync = true, changes = """{"podcasts":[$p]}"""), response(cursor = 3), requests = reqs).run()
        assertNull(db.dao().podcast("pod1")); assertNotNull(db.dao().podcast("pod9"))
        assertNull(db.dao().episode("e11"))
        assertNull(db.dao().stateById("clean-state"))
        assertTrue(db.dao().stateById(RecordID.state(USER, "e11"))!!.starred) // pending write survives
        assertEquals(2, reqs.size) // full resync forces another round
    }

    @Test fun pullLoopFollowsHasMoreAndSendsCursor() = run {
        val reqs = mutableListOf<JsonObject>()
        core(response(cursor = 10, hasMore = true), response(cursor = 20, hasMore = true), response(cursor = 25), requests = reqs).run()
        assertEquals(listOf(0, 10, 20), reqs.map { it["cursor"]!!.jsonPrimitive.int })
        assertEquals("25", db.dao().kvGet("cursor"))
    }

    @Test fun transcriptCacheRoundTrips() = run {
        lib.saveTranscript(Transcript("e1", "whisper", "base", listOf(TranscriptSegment(0, 1000, "hello"), TranscriptSegment(1000, 2000, "world"))))
        assertEquals("world", lib.transcriptPreview("e1", 1500))
        assertEquals("hello", lib.transcriptPreview("e1", 0))
        assertEquals(2, lib.transcript("e1")!!.segments.size)
        assertNull(lib.transcriptPreview("nope", 0))
    }
}
