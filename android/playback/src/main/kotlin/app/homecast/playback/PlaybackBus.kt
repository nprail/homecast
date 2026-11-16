package app.homecast.playback

import app.homecast.contract.PlayerState
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Process-wide rendezvous between the UI-facing [PlayerControllerImpl] and the [PlaybackService]'s engine.
 * Everything runs in the app process, so the engine publishes its state here and the controller hands commands to
 * the engine once the service is up (the controller starts the service by connecting a `MediaController`).
 */
internal object PlaybackBus {
    val state = MutableStateFlow(PlayerState())
    val engine = MutableStateFlow<PlaybackEngine?>(null)
}
