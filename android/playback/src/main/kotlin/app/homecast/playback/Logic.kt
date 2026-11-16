package app.homecast.playback

import app.homecast.contract.DownloadRecord
import app.homecast.contract.PlayContext
import app.homecast.contract.PlayStatus
import app.homecast.contract.SleepMode
import kotlin.math.roundToInt
import kotlin.math.sqrt

// Pure, Android-free logic: unit-tested in src/test.

/** Queue advancement (mirrors iOS `Player.onEnded` / `next`). */
object QueueLogic {
    /** After an episode finished: next id of the playing list, else the head of Up Next (current already dequeued). */
    fun nextAfterEnded(contextIds: List<String>?, currentId: String, queueIds: List<String>): String? {
        contextIds?.let { ids ->
            val i = ids.indexOf(currentId)
            if (i >= 0) ids.getOrNull(i + 1)?.let { return it }
        }
        return queueIds.firstOrNull { it != currentId }
    }

    /** Manual skip to next: same as above but only while the list really has a following item. */
    fun nextOnSkip(contextIds: List<String>?, currentId: String, queueIds: List<String>): String? {
        contextIds?.let { ids ->
            val i = ids.indexOf(currentId)
            if (i >= 0 && i + 1 < ids.size) return ids[i + 1]
        }
        return queueIds.firstOrNull { it != currentId }
    }

    /** Keep the list context while the next episode belongs to it, otherwise fall back to Up Next. */
    fun contextFor(next: String, ctx: PlayContext): PlayContext =
        if (ctx.ids?.contains(next) == true) ctx else PlayContext("Up Next")
}

/** Persistence of [PlayContext] in the library kv store (device-local; format is private to this module). */
object ContextCodec {
    fun encode(ctx: PlayContext): String = "v1\n${ctx.label.replace('\n', ' ')}\n${ctx.ids?.joinToString(",") ?: "-"}"
    fun decode(s: String?): PlayContext {
        if (s == null) return PlayContext()
        val lines = s.split('\n')
        if (lines.size < 3 || lines[0] != "v1") return PlayContext()
        val ids = if (lines[2] == "-") null else lines[2].split(',').filter { it.isNotEmpty() }
        return PlayContext(lines[1].ifBlank { "Up Next" }, ids)
    }
}

object SpeedMath {
    const val MIN = 0.5
    const val MAX = 3.0
    val carCycle = listOf(0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5)

    /** Podcast override, else the global default (spec §3.3). */
    fun resolve(defaultSpeed: Double, overrides: Map<String, Double>, podcastId: String?): Double =
        round(podcastId?.let { overrides[it] } ?: defaultSpeed)

    fun round(v: Double): Double = ((v * 10).roundToInt() / 10.0).coerceIn(MIN, MAX)

    fun nextInCycle(current: Double): Double = carCycle.firstOrNull { it > current + 0.01 } ?: carCycle.first()

    fun label(speed: Double): String = (if (speed % 1.0 == 0.0) speed.toInt().toString() else "%.1f".format(java.util.Locale.US, speed)) + "x"
}

object SleepMath {
    const val FADE_SECONDS = 10.0
    private const val MS = 1000.0

    data class Step(val remainingMs: Long?, val fading: Boolean, val volume: Float, val expired: Boolean)

    /** Remaining time on the sleep timer; null when off. For end-of-episode it accounts for playback speed. */
    fun remainingMs(mode: SleepMode, nowMs: Long, positionMs: Long, durationMs: Long, speed: Double): Long? = when (mode) {
        SleepMode.Off -> null
        is SleepMode.Timer -> maxOf(0L, mode.endsAtMs - nowMs)
        SleepMode.EndOfEpisode -> if (durationMs > 0) (maxOf(0L, durationMs - positionMs) / maxOf(speed, 0.1)).toLong() else null
    }

    /** One 500 ms tick while playing: fade the last 10 s (linear), expire timers at zero. */
    fun evaluate(mode: SleepMode, nowMs: Long, positionMs: Long, durationMs: Long, speed: Double): Step {
        val rem = remainingMs(mode, nowMs, positionMs, durationMs, speed) ?: return Step(null, false, 1f, false)
        if (rem <= 0 && mode is SleepMode.Timer) return Step(rem, false, 1f, true)
        if (rem <= FADE_SECONDS * MS) return Step(rem, true, (rem / (FADE_SECONDS * MS)).toFloat().coerceIn(0f, 1f), false)
        return Step(rem, false, 1f, false)
    }

    /** Shake/tap: add minutes to a running timer, or turn end-of-episode into a timer. Off stays off. */
    fun extend(mode: SleepMode, nowMs: Long, minutes: Int): SleepMode = when (mode) {
        is SleepMode.Timer -> SleepMode.Timer(maxOf(mode.endsAtMs, nowMs) + minutes * 60_000L)
        SleepMode.EndOfEpisode -> SleepMode.Timer(nowMs + minutes * 60_000L)
        SleepMode.Off -> SleepMode.Off
    }

    /** Accelerometer (m/s^2) magnitude above 2.3 g, debounced 1.5 s. */
    fun isShake(x: Float, y: Float, z: Float, nowMs: Long, lastShakeMs: Long): Boolean {
        val g = sqrt(x * x + y * y + z * z) / 9.80665f
        return g > 2.3f && nowMs - lastShakeMs > 1500
    }
}

object CapEviction {
    /** Records to delete so that `total + incoming <= cap`: oldest played first, then oldest of the rest. */
    fun plan(records: List<DownloadRecord>, playedIds: Set<String>, capBytes: Long, incoming: Long = 0): List<DownloadRecord> {
        if (capBytes <= 0) return emptyList()
        var total = records.sumOf { it.bytes }
        if (total + incoming <= capBytes) return emptyList()
        val byAge = records.sortedBy { it.at }
        val order = byAge.filter { it.episodeId in playedIds } + byAge.filter { it.episodeId !in playedIds }
        val out = ArrayList<DownloadRecord>()
        for (r in order) {
            if (total + incoming <= capBytes) break
            out += r
            total -= r.bytes
        }
        return out
    }

    fun shouldCleanUp(status: PlayStatus, playedAtMs: Long?, days: Int?, nowMs: Long): Boolean =
        days != null && days > 0 && status == PlayStatus.Played && playedAtMs != null && nowMs - playedAtMs > days * 86_400_000L
}

object DownloadNaming {
    private val known = listOf("mp3", "m4a", "aac", "mp4", "wav", "ogg", "opus")
    val extensions get() = known

    fun extension(url: String, mime: String?): String {
        val path = url.substringBefore('?').substringBefore('#').substringAfterLast('/')
        val ext = path.substringAfterLast('.', "").lowercase()
        if (ext in known) return ext
        return when (mime?.lowercase()?.substringBefore(';')?.trim()) {
            "audio/mp4", "audio/x-m4a", "audio/m4a" -> "m4a"
            "audio/aac" -> "aac"
            "audio/ogg", "application/ogg" -> "ogg"
            "audio/opus" -> "opus"
            "audio/wav", "audio/x-wav" -> "wav"
            else -> "mp3"
        }
    }
}

/** Android Auto browse tree ids and small formatting helpers (no Android types so they can be tested on the JVM). */
object BrowseIds {
    const val ROOT = "root"
    const val UP_NEXT = "tab:upnext"
    const val PLAYLISTS = "tab:playlists"
    const val PODCASTS = "tab:podcasts"
    const val DOWNLOADS = "tab:downloads"
    const val SIGN_IN = "signin"
    private const val PLAYLIST = "playlist:"
    private const val SMART = "smart:"
    private const val PODCAST = "podcast:"

    sealed interface Node {
        data object Root : Node
        data object UpNext : Node
        data object Playlists : Node
        data object Podcasts : Node
        data object Downloads : Node
        data object SignIn : Node
        data class Playlist(val id: String) : Node
        data class Smart(val id: String) : Node
        data class Podcast(val id: String) : Node
        /** Anything else is an episode id. */
        data class Episode(val id: String) : Node
    }

    fun playlist(id: String) = PLAYLIST + id
    fun smart(id: String) = SMART + id
    fun podcast(id: String) = PODCAST + id

    fun parse(mediaId: String): Node = when {
        mediaId == ROOT -> Node.Root
        mediaId == UP_NEXT -> Node.UpNext
        mediaId == PLAYLISTS -> Node.Playlists
        mediaId == PODCASTS -> Node.Podcasts
        mediaId == DOWNLOADS -> Node.Downloads
        mediaId == SIGN_IN -> Node.SignIn
        mediaId.startsWith(PLAYLIST) -> Node.Playlist(mediaId.removePrefix(PLAYLIST))
        mediaId.startsWith(SMART) -> Node.Smart(mediaId.removePrefix(SMART))
        mediaId.startsWith(PODCAST) -> Node.Podcast(mediaId.removePrefix(PODCAST))
        else -> Node.Episode(mediaId)
    }

    val rootTabs = listOf(UP_NEXT, PLAYLISTS, PODCASTS, DOWNLOADS)
}

object BrowseShape {
    const val MAX_ITEMS = 100

    /** Page a list the way a MediaBrowser asks for it, capped to keep Android Auto lists shallow. */
    fun <T> page(items: List<T>, page: Int, pageSize: Int): List<T> {
        val size = if (pageSize <= 0) MAX_ITEMS else minOf(pageSize, MAX_ITEMS)
        val from = (maxOf(page, 0).toLong() * size).coerceAtMost(items.size.toLong()).toInt()
        return items.subList(from, minOf(items.size, from + size))
    }

    /** Unplayed first (keeping their order), then played: what you'd want in the car. */
    fun <T> unplayedFirst(items: List<T>, isPlayed: (T) -> Boolean): List<T> = items.filter { !isPlayed(it) } + items.filter(isPlayed)

    /** 0 = not played, 1 = partially, 2 = fully (Android Auto `PLAYBACK_STATUS`). */
    fun completionStatus(status: PlayStatus, progress: Float): Int = when {
        status == PlayStatus.Played -> 2
        status == PlayStatus.InProgress || progress > 0.01f -> 1
        else -> 0
    }

    fun durationLabel(seconds: Double): String {
        val m = (seconds / 60).roundToInt()
        return if (m >= 60) "${m / 60} hr ${m % 60} min".replace(" 0 min", "") else "$m min"
    }

    /** Subtitle line of an episode row. */
    fun episodeSubtitle(podcastTitle: String?, status: PlayStatus, durationSec: Double, remainingSec: Double): String {
        val parts = ArrayList<String>(2)
        if (!podcastTitle.isNullOrBlank()) parts += podcastTitle
        if (status == PlayStatus.InProgress && remainingSec > 0) parts += "${durationLabel(remainingSec)} left"
        else if (durationSec > 0) parts += durationLabel(durationSec)
        return parts.joinToString(" · ")
    }

    /** Case-insensitive all-words match used by voice search. */
    fun matches(query: String, vararg fields: String?): Boolean {
        val words = query.lowercase().split(' ', ',', '.').filter { it.isNotBlank() }
        if (words.isEmpty()) return false
        val hay = fields.filterNotNull().joinToString(" ").lowercase()
        return words.all { hay.contains(it) }
    }
}
