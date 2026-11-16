package app.homecast.playback

import android.app.PendingIntent
import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import app.homecast.contract.*
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * Media3 `MediaLibraryService`: owns the ExoPlayer + [PlaybackEngine], the media notification, lock-screen /
 * Bluetooth / headset controls and the Android Auto browse tree. It reaches the data layer through
 * `(application as GraphProvider).graph`, so it works with the UI absent.
 */
class PlaybackService : MediaLibraryService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var exo: ExoPlayer
    private lateinit var engine: PlaybackEngine
    private lateinit var tree: BrowseTree
    private var session: MediaLibrarySession? = null
    private var bookmarkSaved = false

    override fun onCreate() {
        super.onCreate()
        val app = application as Application
        val graphProvider = application as GraphProvider

        val http = OkHttpClient.Builder().build()
        val dataSources = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(http).setUserAgent("Homecast-Android"))
        exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(SKIP_BACK_MS)
            .setSeekForwardIncrementMs(SKIP_FORWARD_MS)
            .build()
        engine = PlaybackEngine(app, graphProvider, exo, CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
        tree = BrowseTree(app, graphProvider)

        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val activity = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val builder = MediaLibrarySession.Builder(this, EnginePlayer(exo, engine), callback)
            .setMediaButtonPreferences(buttons())
        if (activity != null) builder.setSessionActivity(activity)
        session = builder.build()

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(CHANNEL_ID)
                .setChannelName(R.string.playback_channel_name)
                .build().apply { setSmallIcon(R.drawable.ic_stat_homecast) }
        )

        PlaybackBus.engine.value = engine

        // Speed label on the custom action follows the resolved speed.
        scope.launch {
            PlaybackBus.state.map { it.speed }.distinctUntilChanged().collect { refreshButtons() }
        }
        observeLibrary(graphProvider)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep playing in the background; stop only when nothing is playing.
        if (!exo.playWhenReady || exo.mediaItemCount == 0) pauseAllPlayersAndStopSelf()
    }

    override fun onDestroy() {
        PlaybackBus.engine.value = null
        scope.cancel()
        session?.release()
        session = null
        engine.release()
        exo.release()
        super.onDestroy()
    }

    // ---- custom layout ---------------------------------------------------------------------------------------------

    private fun buttons(): List<CommandButton> {
        val speed = PlaybackBus.state.value.speed
        return listOf(
            CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15).setPlayerCommand(Player.COMMAND_SEEK_BACK)
                .setDisplayName("Back 15 seconds").setSlots(CommandButton.SLOT_BACK).build(),
            CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30).setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                .setDisplayName("Forward 30 seconds").setSlots(CommandButton.SLOT_FORWARD).build(),
            CommandButton.Builder(CommandButton.ICON_NEXT).setPlayerCommand(Player.COMMAND_SEEK_TO_NEXT)
                .setDisplayName("Next episode").setSlots(CommandButton.SLOT_FORWARD_SECONDARY).build(),
            CommandButton.Builder(CommandButton.ICON_PLAYBACK_SPEED).setSessionCommand(CMD_SPEED)
                .setDisplayName("Speed ${SpeedMath.label(speed)}").setSlots(CommandButton.SLOT_OVERFLOW).build(),
            CommandButton.Builder(if (bookmarkSaved) CommandButton.ICON_CHECK_CIRCLE_FILLED else CommandButton.ICON_BOOKMARK_FILLED)
                .setSessionCommand(CMD_BOOKMARK)
                .setDisplayName(if (bookmarkSaved) "Bookmark added" else "Add bookmark").setSlots(CommandButton.SLOT_OVERFLOW).build(),
        )
    }

    private fun refreshButtons() {
        session?.setMediaButtonPreferences(buttons())
    }

    // ---- browse-tree invalidation --------------------------------------------------------------------------------

    private fun observeLibrary(graphProvider: GraphProvider) {
        scope.launch {
            val auth = runCatching { graphProvider.graph.session.state }.getOrNull() ?: return@launch
            auth.collectLatest {
                session?.notifyChildrenChanged(BrowseIds.ROOT, BrowseIds.rootTabs.size, null)
                val lib = runCatching { graphProvider.graph.library }.getOrNull() ?: return@collectLatest
                coroutineScope {
                    launch { lib.queue().drop(1).collect { session?.notifyChildrenChanged(BrowseIds.UP_NEXT, it.size, null) } }
                    launch { lib.downloads().drop(1).collect { session?.notifyChildrenChanged(BrowseIds.DOWNLOADS, it.size, null) } }
                    launch { lib.subscribedPodcasts().drop(1).collect { session?.notifyChildrenChanged(BrowseIds.PODCASTS, it.size, null) } }
                    launch { lib.playlists().drop(1).collect { session?.notifyChildrenChanged(BrowseIds.PLAYLISTS, it.size, null) } }
                }
            }
        }
    }

    // ---- session callback (Android Auto, Assistant, Bluetooth, UI controller) ---------------------------------------

    private val callback = object : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                .add(CMD_SPEED).add(CMD_BOOKMARK).build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .setMediaButtonPreferences(buttons())
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle,
        ): ListenableFuture<SessionResult> {
            when (customCommand.customAction) {
                ACTION_SPEED -> engine.setSpeed(SpeedMath.nextInCycle(engine.speed), SpeedScope.Podcast)
                ACTION_BOOKMARK -> if (engine.addBookmarkAtCurrent()) {
                    bookmarkSaved = true
                    refreshButtons()
                    handler.postDelayed({ bookmarkSaved = false; refreshButtons() }, 2_600)
                }
                else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> = Futures.immediateFuture(LibraryResult.ofItem(tree.rootItem(), tree.rootParams()))

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            scope.future {
                tree.item(mediaId)?.let { LibraryResult.ofItem(it, null) } ?: LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
            }

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            val listing = tree.children(parentId, page, pageSize)
            if (listing == null) {
                LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
            } else {
                remember(listing.contexts)
                LibraryResult.ofItemList(listing.items, null)
            }
        }

        override fun onSearch(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<Void>> = scope.future {
            val count = tree.search(query).size
            session.notifySearchResultChanged(browser, query, count, params)
            LibraryResult.ofVoid()
        }

        override fun onGetSearchResult(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            LibraryResult.ofItemList(BrowseShape.page(tree.search(query), page, pageSize), null)
        }

        override fun onAddMediaItems(
            session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>,
        ): ListenableFuture<List<MediaItem>> = scope.future { resolve(mediaItems) }

        /** `play from media id` / voice: resolve to playable episode items; the player wrapper hands them to the engine. */
        override fun onSetMediaItems(
            session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = scope.future {
            val items = resolve(mediaItems)
            val idx = if (items.size == mediaItems.size) startIndex.coerceIn(0, maxOf(0, items.size - 1)) else 0
            MediaSession.MediaItemsWithStartPosition(items, idx, startPositionMs)
        }

        /** Bluetooth / media-button "play" after the app was gone: resume the last episode. */
        override fun onPlaybackResumption(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
            scope.future {
                val lib = tree.library() ?: throw UnsupportedOperationException("Signed out")
                val id = engine.state.episode?.id ?: lib.kvGet("player.episodeId") ?: throw UnsupportedOperationException("Nothing to resume")
                val item = tree.item(id) ?: throw UnsupportedOperationException("Episode not found")
                MediaSession.MediaItemsWithStartPosition(listOf(item), 0, C.TIME_UNSET)
            }
    }

    private suspend fun resolve(items: List<MediaItem>): List<MediaItem> {
        val r = tree.resolveForPlayback(items)
        remember(r.contexts)
        return r.items
    }

    private fun remember(contexts: Map<String, PlayContext>) {
        if (contexts.isEmpty()) return
        if (engine.browseContexts.size > 3_000) engine.browseContexts.clear()
        engine.browseContexts.putAll(contexts)
    }

    // ---- the player the session sees -----------------------------------------------------------------------------------

    /**
     * Wraps the ExoPlayer (which only ever holds the current episode): next/previous, transport and "set media items"
     * are routed to the [PlaybackEngine] so queue logic, saved positions and speed resolution stay in one place.
     */
    private class EnginePlayer(player: Player, private val engine: PlaybackEngine) : ForwardingPlayer(player) {
        override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon().addAll(
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD, Player.COMMAND_SET_SPEED_AND_PITCH,
        ).build()

        override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)

        override fun play() = engine.resume()
        override fun pause() = engine.pause()
        override fun seekBack() = engine.back()
        override fun seekForward() = engine.forward()
        override fun seekToNext() = engine.next()
        override fun seekToNextMediaItem() = engine.next()
        override fun seekToPrevious() = engine.back()
        override fun seekToPreviousMediaItem() = engine.back()
        override fun hasNextMediaItem(): Boolean = true
        override fun setPlaybackParameters(playbackParameters: PlaybackParameters) {
            engine.setSpeed(playbackParameters.speed.toDouble(), SpeedScope.Podcast)
        }
        override fun setPlaybackSpeed(speed: Float) = engine.setSpeed(speed.toDouble(), SpeedScope.Podcast)

        override fun setMediaItem(mediaItem: MediaItem) = engine.playFromMediaItems(listOf(mediaItem), 0)
        override fun setMediaItem(mediaItem: MediaItem, startPositionMs: Long) = engine.playFromMediaItems(listOf(mediaItem), 0)
        override fun setMediaItem(mediaItem: MediaItem, resetPosition: Boolean) = engine.playFromMediaItems(listOf(mediaItem), 0)
        override fun setMediaItems(mediaItems: List<MediaItem>) = engine.playFromMediaItems(mediaItems, 0)
        override fun setMediaItems(mediaItems: List<MediaItem>, resetPosition: Boolean) = engine.playFromMediaItems(mediaItems, 0)
        override fun setMediaItems(mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long) = engine.playFromMediaItems(mediaItems, startIndex)
    }

    companion object {
        const val CHANNEL_ID = "homecast_playback"
        private const val SKIP_BACK_MS = 15_000L
        private const val SKIP_FORWARD_MS = 30_000L
        private const val ACTION_SPEED = "app.homecast.playback.CYCLE_SPEED"
        private const val ACTION_BOOKMARK = "app.homecast.playback.ADD_BOOKMARK"
        private val CMD_SPEED = SessionCommand(ACTION_SPEED, Bundle.EMPTY)
        private val CMD_BOOKMARK = SessionCommand(ACTION_BOOKMARK, Bundle.EMPTY)
    }
}
