package app.homecast.playback

import android.app.Application
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import app.homecast.contract.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The audio engine (port of iOS `Player.swift`): owns the ExoPlayer inside [PlaybackService] and everything that
 * must keep working with the UI absent: position saving, sync pushes, queue advancement, speed, sleep timer.
 * All members must be called on the main thread.
 */
internal class PlaybackEngine(
    private val app: Application,
    private val graphProvider: GraphProvider,
    val exo: ExoPlayer,
    private val scope: CoroutineScope,
) : Player.Listener {

    private var s = PlayerState()
    private var loadToken = 0
    private var ticks = 0
    private var durationRefinedToken = -1
    /** True from `load()` until its media item is set; play/pause pressed in that window overrides the load's autoplay. */
    private var loading = false
    private var intentDuringLoad: Boolean? = null
    /** True while ExoPlayer plays a signed URL for the server's hosted copy (so an expired link can be renewed). */
    private var playingSigned = false
    private var recoveries = 0
    private val shake = ShakeDetector(app) { if (s.isFading) extendSleep(5) }
    private var ticker: Job? = null
    /** Outlives [scope] so the final position write on service teardown isn't cancelled. */
    private val saveScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Where Android Auto's last browsed lists came from: episodeId -> list context (so "play" continues through that list). */
    val browseContexts = HashMap<String, PlayContext>()

    val state: PlayerState get() = s
    val speed: Double get() = s.speed

    init {
        exo.addListener(this)
        ticker = scope.launch {
            while (true) {
                delay(500)
                onTick()
            }
        }
        publish { this }
    }

    private fun graph(): HomecastGraph? = runCatching { graphProvider.graph }.getOrNull()
    private fun library(): Library? = runCatching { graphProvider.graph.library }.getOrNull()
    private fun syncEngine(): SyncEngine? = runCatching { graphProvider.graph.sync }.getOrNull()

    private inline fun publish(block: PlayerState.() -> PlayerState) {
        s = s.block()
        PlaybackBus.state.value = s
    }

    // ---- loading ---------------------------------------------------------------------------------------------

    /** `autoplay == null` keeps whatever play-when-ready the player already has (a MediaController `play()` may race the load). */
    fun load(episodeId: String, autoplay: Boolean?, ctx: PlayContext?, enqueueFront: Boolean = false, allowLocal: Boolean = true) {
        val token = ++loadToken
        persist(syncSoon = false)
        loading = true
        intentDuringLoad = null
        scope.launch {
            val lib = library()
            if (lib == null) {
                if (token == loadToken) loading = false
                if (autoplay != false) publish { copy(error = "Sign in to Homecast to play episodes.") }
                return@launch
            }
            if (enqueueFront) runCatching { lib.enqueue(episodeId, QueuePosition.Front) }
            val item = runCatching { lib.getEpisodeItem(episodeId) }.getOrNull()
            if (item == null) {
                if (token == loadToken) loading = false
                if (token == loadToken && autoplay != false) publish { copy(error = "Episode not found") }
                return@launch
            }
            val settings = runCatching { lib.getSettings() }.getOrDefault(UserSettings())
            val local = if (allowLocal) runCatching { graph()?.downloads?.fileFor(episodeId) }.getOrNull() else null
            // Not downloaded: stream the server's hosted copy through a signed URL when it has one.
            val hosted = if (local == null) hostedUrl(episodeId) else null
            if (token != loadToken) return@launch
            loading = false
            val effectiveAutoplay = intentDuringLoad ?: autoplay

            val ep = item.episode
            val newSpeed = SpeedMath.resolve(settings.defaultSpeed, settings.podcastSpeeds, ep.podcastId)
            val resumeMs = if (item.status == PlayStatus.Played) 0L else item.positionMs
            val context = ctx ?: s.context
            publish {
                copy(
                    episode = ep, podcast = item.podcast, speed = newSpeed, speedIsOverride = settings.podcastSpeeds.containsKey(ep.podcastId),
                    positionMs = resumeMs, durationMs = (ep.durationSec * 1000).toLong(), context = context, error = null,
                    playingOffline = local != null, isBuffering = effectiveAutoplay != false, isFading = false,
                )
            }
            exo.volume = 1f
            playingSigned = local == null && hosted != null
            recoveries = 0
            exo.setMediaItem(mediaItem(ep, item.podcast, local, hosted, s.durationMs), resumeMs)
            exo.playbackParameters = PlaybackParameters(newSpeed.toFloat(), 1f)
            exo.prepare()
            if (effectiveAutoplay != null) exo.playWhenReady = effectiveAutoplay
            runCatching {
                lib.kvSet("player.episodeId", episodeId)
                lib.kvSet("player.context", ContextCodec.encode(context))
            }
            if (effectiveAutoplay != false && item.status != PlayStatus.InProgress && s.durationMs > 0) {
                runCatching { lib.savePosition(episodeId, resumeMs, s.durationMs) }
            }
        }
    }

    /** The signed URL for the server's hosted copy, or null (not hosted, offline, or too slow). */
    private suspend fun hostedUrl(episodeId: String): String? =
        runCatching { withTimeoutOrNull(5_000) { graph()?.remote?.streamUrl(episodeId) } }.getOrNull()

    /**
     * A signed link can expire mid-listen (or the hosted copy can be deleted): renew it and carry on from the same place.
     * After two failed renewals give up on the server's copy and use the podcast's own URL.
     */
    private fun renewStream() {
        val ep = s.episode ?: return
        val position = exo.currentPosition
        val play = exo.playWhenReady
        val attempt = ++recoveries
        scope.launch {
            val fresh = if (attempt <= 2) hostedUrl(ep.id) else null
            if (s.episode?.id != ep.id) return@launch
            playingSigned = fresh != null
            exo.setMediaItem(mediaItem(ep, s.podcast, null, fresh, s.durationMs), position)
            exo.prepare()
            exo.playWhenReady = play
        }
    }

    private fun mediaItem(ep: Episode, pod: Podcast?, local: File?, hosted: String?, durationMs: Long): MediaItem {
        val md = MediaMetadata.Builder()
            .setTitle(ep.title)
            .setArtist(pod?.title)
            .setAlbumTitle(pod?.title)
            .setArtworkUri(pod?.imageUrl?.let { runCatching { Uri.parse(it) }.getOrNull() })
            .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .apply { if (durationMs > 0) setDurationMs(durationMs) }
            .build()
        val b = MediaItem.Builder()
            .setMediaId(ep.id)
            .setUri(if (local != null) Uri.fromFile(local) else Uri.parse(hosted ?: ep.audioUrl))
            .setMediaMetadata(md)
        if (local == null && ep.mimeType.isNotBlank()) b.setMimeType(ep.mimeType)
        return b.build()
    }

    /** `play(...)` of the UI contract: a bare "Up Next" play puts the episode at the front of the queue. */
    fun play(episodeId: String, ids: List<String>?, label: String) {
        load(episodeId, true, PlayContext(label, ids), enqueueFront = ids == null && label == "Up Next")
    }

    /** Android Auto / voice / Bluetooth `setMediaItems`: media ids are episode ids. */
    fun playFromMediaItems(items: List<MediaItem>, startIndex: Int) {
        val ids = items.map { it.mediaId }.filter { it.isNotEmpty() }
        val id = items.getOrNull(startIndex)?.mediaId?.takeIf { it.isNotEmpty() } ?: ids.firstOrNull() ?: return
        val ctx = browseContexts[id] ?: if (ids.size > 1) PlayContext("Up Next", ids) else PlayContext("Up Next")
        if (id == s.episode?.id && exo.mediaItemCount > 0) return // already loaded: the following `play()` just resumes
        load(id, null, ctx)
    }

    // ---- Player.Listener --------------------------------------------------------------------------------------

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying == s.isPlaying) return
        publish { copy(isPlaying = isPlaying, isBuffering = false) }
        if (!isPlaying) persist(syncSoon = true)
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = updateBuffering()

    override fun onPlaybackStateChanged(playbackState: Int) {
        updateBuffering()
        when (playbackState) {
            Player.STATE_READY -> {
                if (s.error != null) publish { copy(error = null) }
                refineDuration()
            }
            Player.STATE_ENDED -> onEnded()
        }
    }

    override fun onPlayerError(error: PlaybackException) {
        if (s.playingOffline && error.errorCode == PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND) {
            // The file vanished (cleared storage): fall back to streaming.
            s.episode?.let { load(it.id, exo.playWhenReady, s.context, allowLocal = false) }
            return
        }
        if (playingSigned) {
            renewStream()
            return
        }
        val msg = when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                "You're offline. Download episodes to listen without a connection."
            else -> "Couldn't play this episode."
        }
        publish { copy(error = msg, isPlaying = false, isBuffering = false) }
    }

    private fun updateBuffering() {
        val buffering = exo.playbackState == Player.STATE_BUFFERING && exo.playWhenReady && exo.mediaItemCount > 0
        if (buffering != s.isBuffering) publish { copy(isBuffering = buffering) }
    }

    private fun refineDuration() {
        val d = exo.duration
        if (d == C.TIME_UNSET || d <= 0) return
        if (d != s.durationMs) publish { copy(durationMs = d) }
        if (durationRefinedToken == loadToken) return
        durationRefinedToken = loadToken
        val ep = s.episode ?: return
        // Feeds without (or with wrong) durations get the real value locally once the metadata loads.
        if (abs(ep.durationSec - d / 1000.0) > 2) {
            val sec = (d / 1000.0).roundToLong().toDouble()
            publish { copy(episode = ep.copy(durationSec = sec)) }
            scope.launch { runCatching { library()?.updateEpisodeDuration(ep.id, sec) } }
        }
    }

    // ---- tick: position, persistence, sync, sleep ----------------------------------------------------------------

    private fun onTick() {
        if (s.episode == null || exo.mediaItemCount == 0) return
        val pos = exo.currentPosition.coerceAtLeast(0)
        if (pos != s.positionMs && exo.playbackState != Player.STATE_ENDED) publish { copy(positionMs = pos) }
        if (!exo.isPlaying) return
        ticks++
        if (ticks % 10 == 0) persist(syncSoon = false)                                     // every 5 s
        if (ticks % 60 == 0) scope.launch { runCatching { syncEngine()?.sync() } }          // every 30 s while online
        tickSleep()
    }

    private fun persist(syncSoon: Boolean) {
        val ep = s.episode ?: return
        if (exo.mediaItemCount == 0) return
        val pos = exo.currentPosition
        if (pos < 0) return
        // Unknown duration: pass a huge one so the "within 5 s of the end" rule can't mark the episode played.
        val dur = if (s.durationMs > 0) s.durationMs else Long.MAX_VALUE / 4
        saveScope.launch {
            runCatching { library()?.savePosition(ep.id, pos, dur) }
            if (syncSoon) runCatching { syncEngine()?.schedule(1500) }
        }
    }

    // ---- controls ---------------------------------------------------------------------------------------------

    fun toggle() = if (exo.playWhenReady && exo.playbackState != Player.STATE_ENDED) pause() else resume()

    fun pause() {
        if (loading) intentDuringLoad = false
        exo.pause()
    }

    fun resume() {
        if (loading) {
            intentDuringLoad = true
            exo.playWhenReady = true
            return
        }
        val ep = s.episode
        if (exo.mediaItemCount == 0) {
            if (ep != null) load(ep.id, true, s.context)
            return
        }
        if (exo.playbackState == Player.STATE_ENDED) exo.seekTo(0)
        else if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
        exo.play()
    }

    fun seekTo(ms: Long) {
        if (exo.mediaItemCount == 0) return
        val max = if (s.durationMs > 0) s.durationMs else Long.MAX_VALUE
        val clamped = ms.coerceIn(0, max)
        exo.seekTo(clamped)
        publish { copy(positionMs = clamped) }
    }

    fun skip(seconds: Int) = seekTo(exo.currentPosition + seconds * 1000L)
    fun back() = skip(-15)
    fun forward() = skip(30)

    fun next() {
        val ep = s.episode ?: return
        val ctx = s.context
        scope.launch {
            val lib = library() ?: return@launch
            val next = QueueLogic.nextOnSkip(ctx.ids, ep.id, runCatching { lib.queueIds() }.getOrDefault(emptyList())) ?: return@launch
            runCatching { lib.dequeue(ep.id) }
            load(next, true, QueueLogic.contextFor(next, ctx))
        }
    }

    private fun onEnded() {
        val ep = s.episode ?: return
        val ctx = s.context
        scope.launch {
            val lib = library()
            if (lib != null) {
                runCatching { lib.markPlayed(ep.id) }
                runCatching { lib.dequeue(ep.id) }
                runCatching { syncEngine()?.schedule(500) }
            }
            if (ep.id != s.episode?.id) return@launch // something else was loaded meanwhile
            publish { copy(positionMs = 0) }
            if (s.sleep == SleepMode.EndOfEpisode) {
                publish { copy(sleep = SleepMode.Off, isFading = false) }
                exo.volume = 1f
                shake.stop()
                stopAtStart()
                return@launch
            }
            val queue = if (lib != null) runCatching { lib.queueIds() }.getOrDefault(emptyList()) else emptyList()
            val next = QueueLogic.nextAfterEnded(ctx.ids, ep.id, queue)
            if (next != null) load(next, true, QueueLogic.contextFor(next, ctx)) else stopAtStart()
        }
    }

    private fun stopAtStart() {
        exo.playWhenReady = false
        publish { copy(isPlaying = false, isBuffering = false, positionMs = 0) }
    }

    // ---- speed (spec §3.3) -------------------------------------------------------------------------------------

    fun setSpeed(value: Double, scope: SpeedScope) {
        val sp = SpeedMath.round(value)
        val pod = s.podcast
        this.scope.launch {
            val lib = library() ?: return@launch
            runCatching {
                if (scope == SpeedScope.Podcast && pod != null) lib.setPodcastSpeed(pod.id, sp) else lib.setDefaultSpeed(sp)
            }
            refreshSpeed()
        }
    }

    fun clearSpeedOverride() {
        val pod = s.podcast ?: return
        scope.launch {
            runCatching { library()?.setPodcastSpeed(pod.id, null) }
            refreshSpeed()
        }
    }

    fun refreshSpeed() {
        val ep = s.episode ?: return
        scope.launch {
            val st = runCatching { library()?.getSettings() }.getOrNull() ?: return@launch
            if (s.episode?.id != ep.id) return@launch
            val sp = SpeedMath.resolve(st.defaultSpeed, st.podcastSpeeds, ep.podcastId)
            publish { copy(speed = sp, speedIsOverride = st.podcastSpeeds.containsKey(ep.podcastId)) }
            exo.playbackParameters = PlaybackParameters(sp.toFloat(), 1f) // pitch stays 1.0: pitch-corrected speech
        }
    }

    // ---- bookmarks ---------------------------------------------------------------------------------------------

    /** Returns false when nothing is loaded. */
    fun addBookmarkAtCurrent(title: String? = null, note: String? = null): Boolean {
        val ep = s.episode ?: return false
        val pos = exo.currentPosition.coerceAtLeast(0)
        scope.launch { runCatching { library()?.addBookmark(ep.id, pos, title, note) } }
        return true
    }

    // ---- sleep timer (spec §3.4; device-local, not synced) -----------------------------------------------------

    fun setSleep(mode: SleepMode) {
        publish { copy(sleep = mode, isFading = false) }
        exo.volume = 1f
        if (mode == SleepMode.Off) shake.stop() else shake.start()
    }

    fun setSleepTimer(minutes: Int) = setSleep(SleepMode.Timer(System.currentTimeMillis() + minutes * 60_000L))

    fun extendSleep(minutes: Int) {
        val n = SleepMath.extend(s.sleep, System.currentTimeMillis(), minutes)
        if (n != SleepMode.Off) setSleep(n)
    }

    private fun tickSleep() {
        if (s.sleep == SleepMode.Off) return
        val step = SleepMath.evaluate(s.sleep, System.currentTimeMillis(), exo.currentPosition, s.durationMs, s.speed)
        when {
            step.expired -> {
                exo.pause()
                exo.volume = 1f
                publish { copy(sleep = SleepMode.Off, isFading = false) }
                shake.stop()
            }
            step.fading -> {
                exo.volume = step.volume
                if (!s.isFading) publish { copy(isFading = true) }
            }
            s.isFading -> {
                exo.volume = 1f
                publish { copy(isFading = false) }
            }
        }
    }

    // ---- lifecycle -----------------------------------------------------------------------------------------------

    fun release() {
        persist(syncSoon = true)
        ticker?.cancel()
        shake.stop()
        exo.removeListener(this)
        publish { copy(isPlaying = false, isBuffering = false) }
        scope.cancel()
    }
}
