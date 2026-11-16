package app.homecast.playback

import android.app.Application
import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.homecast.contract.*
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * UI-facing [PlayerController]. Playback itself lives in [PlaybackService]; this class starts it by connecting a
 * `MediaController` (which binds the service), queues commands until the service's engine is up, and exposes the
 * engine's published state. Commands that need no running service (pause, seek...) are no-ops without one.
 */
internal class PlayerControllerImpl(
    private val app: Application,
    private val graphProvider: GraphProvider,
) : PlayerController {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayList<(PlaybackEngine) -> Unit>()
    private var controllerFuture: ListenableFuture<MediaController>? = null

    override val state: StateFlow<PlayerState> = PlaybackBus.state

    init {
        scope.launch {
            PlaybackBus.engine.collect { engine ->
                if (engine != null && pending.isNotEmpty()) {
                    val run = pending.toList()
                    pending.clear()
                    run.forEach { it(engine) }
                }
            }
        }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }

    /** Runs [block] on the engine; when [start] and the service isn't running, starts it first. */
    private fun withEngine(start: Boolean = false, block: (PlaybackEngine) -> Unit) = onMain {
        val engine = PlaybackBus.engine.value
        when {
            engine != null -> block(engine)
            start -> {
                pending += block
                connect()
            }
        }
    }

    private fun connect() {
        val old = controllerFuture
        if (old != null && !old.isDone) return // still connecting
        old?.let { MediaController.releaseFuture(it) }
        val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(app, token).buildAsync()
    }

    override fun play(episodeId: String, ids: List<String>?, label: String) = withEngine(start = true) { it.play(episodeId, ids, label) }
    override fun toggle() = withEngine(start = true) { it.toggle() }
    override fun pause() = withEngine { it.pause() }
    override fun resume() = withEngine(start = true) { it.resume() }
    override fun seekTo(ms: Long) = withEngine { it.seekTo(ms) }
    override fun skip(seconds: Int) = withEngine { it.skip(seconds) }
    override fun back() = withEngine { it.back() }
    override fun forward() = withEngine { it.forward() }
    override fun next() = withEngine { it.next() }

    override fun setSpeed(speed: Double, scope: SpeedScope) = onMain {
        val engine = PlaybackBus.engine.value
        if (engine != null) {
            engine.setSpeed(speed, scope)
        } else {
            // No service yet: still persist the setting.
            val podcastId = state.value.podcast?.id
            val v = SpeedMath.round(speed)
            this.scope.launch {
                val lib = runCatching { graphProvider.graph.library }.getOrNull() ?: return@launch
                runCatching { if (scope == SpeedScope.Podcast && podcastId != null) lib.setPodcastSpeed(podcastId, v) else lib.setDefaultSpeed(v) }
            }
        }
    }

    override fun clearSpeedOverride() = onMain {
        val engine = PlaybackBus.engine.value
        val podcastId = state.value.podcast?.id ?: return@onMain
        if (engine != null) engine.clearSpeedOverride()
        else scope.launch { runCatching { graphProvider.graph.library.setPodcastSpeed(podcastId, null) } }
    }

    override fun refreshSpeed() = withEngine { it.refreshSpeed() }
    override fun setSleep(mode: SleepMode) = withEngine { it.setSleep(mode) }
    override fun setSleepTimer(minutes: Int) = withEngine { it.setSleepTimer(minutes) }
    override fun extendSleep(minutes: Int) = withEngine { it.extendSleep(minutes) }
    override fun addBookmarkAtCurrent(title: String?, note: String?) = withEngine { it.addBookmarkAtCurrent(title, note) }

    override fun restore() {
        onMain {
            if (state.value.hasEpisode) return@onMain
            scope.launch {
                val lib = runCatching { graphProvider.graph.library }.getOrNull() ?: return@launch
                val id = runCatching { lib.kvGet("player.episodeId") }.getOrNull() ?: return@launch
                val ctx = ContextCodec.decode(runCatching { lib.kvGet("player.context") }.getOrNull())
                withEngine(start = true) { e -> if (e.state.episode == null) e.load(id, autoplay = false, ctx = ctx) }
            }
        }
    }
}
