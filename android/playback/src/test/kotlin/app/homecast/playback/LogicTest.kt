package app.homecast.playback

import app.homecast.contract.DownloadRecord
import app.homecast.contract.PlayContext
import app.homecast.contract.PlayStatus
import app.homecast.contract.SleepMode
import org.junit.Assert.*
import org.junit.Test

class LogicTest {
    // ---- queue advancement
    @Test fun endedContinuesThroughListThenQueue() {
        val ids = listOf("a", "b", "c")
        assertEquals("b", QueueLogic.nextAfterEnded(ids, "a", listOf("q1")))
        assertEquals("q1", QueueLogic.nextAfterEnded(ids, "c", listOf("q1")))
        assertNull(QueueLogic.nextAfterEnded(ids, "c", emptyList()))
        assertEquals("q1", QueueLogic.nextAfterEnded(null, "x", listOf("x", "q1")))
    }

    @Test fun skipOnlyUsesListWhileItHasANext() {
        assertEquals("b", QueueLogic.nextOnSkip(listOf("a", "b"), "a", emptyList()))
        assertEquals("q", QueueLogic.nextOnSkip(listOf("a", "b"), "b", listOf("b", "q")))
        assertNull(QueueLogic.nextOnSkip(listOf("a"), "a", listOf("a")))
    }

    @Test fun contextFallsBackToUpNext() {
        val ctx = PlayContext("Mix", listOf("a", "b"))
        assertEquals(ctx, QueueLogic.contextFor("b", ctx))
        assertEquals(PlayContext("Up Next"), QueueLogic.contextFor("z", ctx))
    }

    @Test fun contextCodecRoundTrips() {
        val ctx = PlayContext("My list", listOf("a", "b"))
        assertEquals(ctx, ContextCodec.decode(ContextCodec.encode(ctx)))
        assertEquals(PlayContext("Up Next", null), ContextCodec.decode(ContextCodec.encode(PlayContext())))
        assertEquals(PlayContext(), ContextCodec.decode("garbage"))
    }

    // ---- speed
    @Test fun speedResolutionAndCycle() {
        assertEquals(1.5, SpeedMath.resolve(1.0, mapOf("p" to 1.5), "p"), 0.0)
        assertEquals(1.2, SpeedMath.resolve(1.2, mapOf("p" to 1.5), "other"), 0.0)
        assertEquals(3.0, SpeedMath.round(3.7), 0.0)
        assertEquals(0.5, SpeedMath.round(0.1), 0.0)
        assertEquals(1.3, SpeedMath.round(1.2999), 0.0)
        assertEquals(1.2, SpeedMath.nextInCycle(1.0), 0.0)
        assertEquals(0.8, SpeedMath.nextInCycle(2.5), 0.0)
        assertEquals(1.0, SpeedMath.nextInCycle(0.8), 0.0)
    }

    // ---- sleep timer
    @Test fun timerFadesInLastTenSecondsThenExpires() {
        val mode = SleepMode.Timer(100_000)
        assertFalse(SleepMath.evaluate(mode, 80_000, 0, 0, 1.0).fading)
        val mid = SleepMath.evaluate(mode, 95_000, 0, 0, 1.0)
        assertTrue(mid.fading); assertEquals(0.5f, mid.volume, 0.001f)
        val end = SleepMath.evaluate(mode, 100_000, 0, 0, 1.0)
        assertTrue(end.expired)
        assertTrue(SleepMath.evaluate(SleepMode.Off, 0, 0, 0, 1.0).remainingMs == null)
    }

    @Test fun endOfEpisodeAccountsForSpeedAndFadesButNeverExpires() {
        val s = SleepMath.evaluate(SleepMode.EndOfEpisode, 0, positionMs = 90_000, durationMs = 100_000, speed = 2.0)
        assertEquals(5_000L, s.remainingMs); assertTrue(s.fading); assertFalse(s.expired)
        assertFalse(SleepMath.evaluate(SleepMode.EndOfEpisode, 0, 100_000, 100_000, 1.0).expired)
    }

    @Test fun extendAddsOrRestarts() {
        assertEquals(SleepMode.Timer(100_000 + 300_000), SleepMath.extend(SleepMode.Timer(100_000), 50_000, 5))
        assertEquals(SleepMode.Timer(500_000 + 300_000), SleepMath.extend(SleepMode.Timer(100_000), 500_000, 5)) // already ended
        assertEquals(SleepMode.Timer(1_000 + 300_000), SleepMath.extend(SleepMode.EndOfEpisode, 1_000, 5))
        assertEquals(SleepMode.Off, SleepMath.extend(SleepMode.Off, 1_000, 5))
    }

    @Test fun shakeThresholdAndDebounce() {
        assertTrue(SleepMath.isShake(0f, 0f, 30f, 10_000, 0))
        assertFalse(SleepMath.isShake(0f, 0f, 9.8f, 10_000, 0))
        assertFalse(SleepMath.isShake(0f, 0f, 30f, 10_000, 9_000))
    }

    // ---- storage
    private fun rec(id: String, bytes: Long, at: Long) = DownloadRecord(id, "p", bytes, at, "$id.mp3")

    @Test fun capEvictsOldestPlayedThenOldest() {
        val rows = listOf(rec("old", 100, 1), rec("playedNew", 100, 4), rec("mid", 100, 2), rec("playedOld", 100, 3))
        val played = setOf("playedNew", "playedOld")
        assertEquals(listOf("playedOld"), CapEviction.plan(rows, played, 350).map { it.episodeId })
        assertEquals(listOf("playedOld", "playedNew", "old"), CapEviction.plan(rows, played, 150).map { it.episodeId })
        assertTrue(CapEviction.plan(rows, played, 0).isEmpty())
        assertTrue(CapEviction.plan(rows, played, 1_000).isEmpty())
        assertEquals(2, CapEviction.plan(rows, played, 400, incoming = 150).size)
    }

    @Test fun cleanupRule() {
        val day = 86_400_000L
        assertTrue(CapEviction.shouldCleanUp(PlayStatus.Played, 0, 3, 4 * day))
        assertFalse(CapEviction.shouldCleanUp(PlayStatus.Played, 2 * day, 3, 4 * day))
        assertFalse(CapEviction.shouldCleanUp(PlayStatus.InProgress, 0, 3, 10 * day))
        assertFalse(CapEviction.shouldCleanUp(PlayStatus.Played, 0, null, 10 * day))
    }

    @Test fun fileExtensions() {
        assertEquals("m4a", DownloadNaming.extension("https://x/a/b.M4A?token=1", "audio/mpeg"))
        assertEquals("m4a", DownloadNaming.extension("https://x/stream", "audio/x-m4a"))
        assertEquals("mp3", DownloadNaming.extension("https://x/stream", null))
    }

    // ---- Android Auto browse tree shaping
    @Test fun browseIdsRoundTrip() {
        assertEquals(BrowseIds.Node.Podcast("abc"), BrowseIds.parse(BrowseIds.podcast("abc")))
        assertEquals(BrowseIds.Node.Smart("s1"), BrowseIds.parse(BrowseIds.smart("s1")))
        assertEquals(BrowseIds.Node.Playlist("p1"), BrowseIds.parse(BrowseIds.playlist("p1")))
        assertEquals(BrowseIds.Node.UpNext, BrowseIds.parse(BrowseIds.UP_NEXT))
        assertEquals(BrowseIds.Node.Episode("1234-uuid"), BrowseIds.parse("1234-uuid"))
        assertEquals(4, BrowseIds.rootTabs.size)
    }

    @Test fun paging() {
        val xs = (1..250).toList()
        assertEquals(100, BrowseShape.page(xs, 0, 500).size)
        assertEquals((101..200).toList(), BrowseShape.page(xs, 1, 100))
        assertTrue(BrowseShape.page(xs, 9, 100).isEmpty())
        assertEquals(listOf(1, 2, 3), BrowseShape.page(xs, 0, 3))
    }

    @Test fun listShaping() {
        assertEquals(listOf(2, 4, 1, 3), BrowseShape.unplayedFirst(listOf(1, 2, 3, 4)) { it % 2 == 1 })
        assertEquals(2, BrowseShape.completionStatus(PlayStatus.Played, 1f))
        assertEquals(1, BrowseShape.completionStatus(PlayStatus.InProgress, 0.3f))
        assertEquals(0, BrowseShape.completionStatus(PlayStatus.Unplayed, 0f))
        assertEquals("Show · 12 min left", BrowseShape.episodeSubtitle("Show", PlayStatus.InProgress, 3600.0, 720.0))
        assertEquals("Show · 1 hr 30 min", BrowseShape.episodeSubtitle("Show", PlayStatus.Unplayed, 5400.0, 5400.0))
        assertEquals("1 hr", BrowseShape.durationLabel(3600.0))
    }

    @Test fun voiceSearchMatching() {
        assertTrue(BrowseShape.matches("daily news", "The Daily", "NYT news desk"))
        assertFalse(BrowseShape.matches("daily sports", "The Daily", "NYT news desk"))
        assertFalse(BrowseShape.matches("  ", "anything"))
    }
}
