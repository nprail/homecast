package app.homecast.playback

import android.app.Application
import app.homecast.contract.*

/**
 * Entry point of the playback layer: one instance per process.
 * `graph.library` / `graph.sync` are read lazily (they only exist while signed in).
 */
class PlaybackComponents(app: Application, graph: GraphProvider) {
    val downloads: DownloadsController by lazy { DownloadsControllerImpl(app, graph) }
    val player: PlayerController by lazy { PlayerControllerImpl(app, graph) }
}
