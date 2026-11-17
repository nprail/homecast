package app.homecast.android

import android.app.Application
import app.homecast.contract.*
import app.homecast.core.CoreComponents
import app.homecast.playback.PlaybackComponents
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Process-wide composition root. The playback service (and Android Auto) can start with no UI, so the graph
 * lives here rather than in an Activity.
 */
class HomecastApp : Application(), GraphProvider {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val core by lazy { CoreComponents(this) }
    private val playback by lazy { PlaybackComponents(this, this) }

    override val graph: HomecastGraph by lazy {
        object : HomecastGraph {
            override val session get() = core.session
            override val library get() = core.library
            override val remote get() = core.remote
            override val sync get() = core.sync
            override val player get() = playback.player
            override val downloads get() = playback.downloads
        }
    }

    override fun onCreate() {
        super.onCreate()
        val g = graph
        g.sync.onMerged = {
            g.downloads.runAutoDownloads()
            g.downloads.cleanup()
            g.player.refreshSpeed()
            g.player.resumeFromSync()
        }
        scope.launch {
            g.session.state.collect { if (it is AuthState.SignedIn) g.player.restore() }
        }
    }
}
