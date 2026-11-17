package app.homecast.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.first
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.*
import app.homecast.android.ui.auth.AuthScreen
import app.homecast.android.ui.bookmarks.BookmarkSheet
import app.homecast.android.ui.bookmarks.BookmarksScreen
import app.homecast.android.ui.components.HomecastLogo
import app.homecast.android.ui.discover.DiscoverScreen
import app.homecast.android.ui.downloads.DownloadsScreen
import app.homecast.android.ui.episode.EpisodeScreen
import app.homecast.android.ui.library.AddPodcastSheet
import app.homecast.android.ui.library.EpisodeListKind
import app.homecast.android.ui.library.EpisodeListScreen
import app.homecast.android.ui.library.LibraryScreen
import app.homecast.android.ui.player.MiniPlayer
import app.homecast.android.ui.player.NowPlayingScreen
import app.homecast.android.ui.player.PlaylistPickerSheet
import app.homecast.android.ui.podcast.PodcastScreen
import app.homecast.android.ui.queue.*
import app.homecast.android.ui.search.TranscriptSearchScreen
import app.homecast.android.ui.settings.SettingsScreen
import app.homecast.android.ui.transcript.TranscriptScreen
import app.homecast.contract.AuthState
import app.homecast.contract.HomecastGraph

val LocalGraph = staticCompositionLocalOf<HomecastGraph> { error("HomecastGraph not provided") }

/** Global UI state that any row or screen can trigger: sheets, the full-screen player, snackbars. */
@Stable
class AppUi(val snackbar: SnackbarHostState) {
    var showPlayer by mutableStateOf(false)
    var showAddPodcast by mutableStateOf(false)
    var bookmarkTarget by mutableStateOf<BookmarkTarget?>(null)
    var playlistPickerEpisodeId by mutableStateOf<String?>(null)
    var smartEditorId by mutableStateOf<String?>(null)
    var showSmartEditor by mutableStateOf(false)
    /** Fire-and-forget confirmation message. */
    suspend fun toast(message: String) { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(message) }
}
data class BookmarkTarget(val episodeId: String, val positionMs: Long, val existingBookmarkId: String? = null)
val LocalAppUi = staticCompositionLocalOf<AppUi> { error("AppUi not provided") }

/** Typed navigation. Routes are plain strings so screens stay decoupled from the NavHost. */
class AppNav(val controller: NavHostController) {
    fun back() { controller.popBackStack() }
    fun podcast(id: String) = controller.navigate("podcast/$id")
    fun episode(id: String) = controller.navigate("episode/$id")
    fun playlist(id: String) = controller.navigate("playlist/$id")
    fun smartPlaylist(id: String) = controller.navigate("smart/$id")
    fun transcript(episodeId: String) = controller.navigate("transcript/$episodeId")
    fun bookmarks() = controller.navigate("bookmarks")
    fun starred() = controller.navigate("starred")
    fun latest() = controller.navigate("latest")
    fun searchTranscripts() = controller.navigate("search")
    fun tab(route: String) = controller.navigate(route) { popUpTo(controller.graph.findStartDestination().id) { saveState = true }; launchSingleTop = true; restoreState = true }
}

private enum class Tab(val route: String, val label: String, val icon: ImageVector, val selected: ImageVector) {
    Library("library", "Library", Icons.Outlined.LibraryMusic, Icons.Filled.LibraryMusic),
    UpNext("upnext", "Up Next", Icons.Outlined.QueueMusic, Icons.Filled.QueueMusic),
    Discover("discover", "Discover", Icons.Outlined.Explore, Icons.Filled.Explore),
    Downloads("downloads", "Downloads", Icons.Outlined.DownloadForOffline, Icons.Filled.DownloadForOffline),
    Settings("settings", "Settings", Icons.Outlined.Settings, Icons.Filled.Settings),
}

@Composable
fun AppRoot() {
    val graph = LocalGraph.current
    val auth by graph.session.state.collectAsStateWithLifecycle()
    when (auth) {
        AuthState.Launching -> Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) { HomecastLogo(88.dp) }
        AuthState.SignedOut -> AuthScreen()
        is AuthState.SignedIn -> MainShell()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainShell() {
    val graph = LocalGraph.current
    val snackbar = remember { SnackbarHostState() }
    val ui = remember { AppUi(snackbar) }
    val nav = rememberNavController()
    val appNav = remember(nav) { AppNav(nav) }
    val player by graph.player.state.collectAsStateWithLifecycle()
    val backStack by nav.currentBackStackEntryAsState()
    val currentTab = Tab.entries.firstOrNull { t -> backStack?.destination?.hierarchy?.any { it.route == t.route } == true }

    DebugHooks(appNav, ui)
    // A tapped "new episode" notification opens that episode.
    LaunchedEffect(Unit) {
        app.homecast.android.notify.PendingOpen.episodeId.collect { id ->
            if (id != null) { app.homecast.android.notify.PendingOpen.episodeId.value = null; ui.showPlayer = false; appNav.episode(id) }
        }
    }
    CompositionLocalProvider(LocalAppUi provides ui) {
        Box(Modifier.fillMaxSize()) {
            Scaffold(
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    Column {
                        AnimatedVisibility(player.hasEpisode, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) { MiniPlayer(onOpen = { ui.showPlayer = true }) }
                        NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
                            Tab.entries.forEach { t ->
                                val sel = currentTab == t
                                NavigationBarItem(
                                    selected = sel,
                                    onClick = { appNav.tab(t.route) },
                                    icon = { Icon(if (sel) t.selected else t.icon, contentDescription = null) },
                                    label = { Text(t.label) },
                                )
                            }
                        }
                    }
                },
            ) { padding ->
                NavHost(nav, startDestination = Tab.Library.route, modifier = Modifier.padding(bottom = padding.calculateBottomPadding())) {
                    composable("library") { LibraryScreen(appNav) }
                    composable("upnext") { QueueScreen(appNav) }
                    composable("discover") { DiscoverScreen(appNav) }
                    composable("downloads") { DownloadsScreen(appNav) }
                    composable("settings") { SettingsScreen(appNav) }
                    composable("podcast/{id}") { PodcastScreen(it.arguments!!.getString("id")!!, appNav) }
                    composable("episode/{id}") { EpisodeScreen(it.arguments!!.getString("id")!!, appNav) }
                    composable("playlist/{id}") { PlaylistScreen(it.arguments!!.getString("id")!!, appNav) }
                    composable("smart/{id}") { SmartPlaylistScreen(it.arguments!!.getString("id")!!, appNav) }
                    composable("transcript/{id}") { TranscriptScreen(it.arguments!!.getString("id")!!, appNav) }
                    composable("bookmarks") { BookmarksScreen(appNav) }
                    composable("starred") { EpisodeListScreen(EpisodeListKind.Starred, appNav) }
                    composable("latest") { EpisodeListScreen(EpisodeListKind.Latest, appNav) }
                    composable("search") { TranscriptSearchScreen(appNav) }
                }
            }
            // Full-screen player rises over everything.
            AnimatedVisibility(ui.showPlayer, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
                BackHandler { ui.showPlayer = false }
                NowPlayingScreen(onClose = { ui.showPlayer = false }, nav = appNav)
            }
        }
        if (ui.showAddPodcast) AddPodcastSheet(onDismiss = { ui.showAddPodcast = false })
        ui.bookmarkTarget?.let { BookmarkSheet(it, onDismiss = { ui.bookmarkTarget = null }) }
        ui.playlistPickerEpisodeId?.let { PlaylistPickerSheet(it, onDismiss = { ui.playlistPickerEpisodeId = null }) }
        if (ui.showSmartEditor) SmartPlaylistEditorSheet(existingId = ui.smartEditorId, onDismiss = { ui.showSmartEditor = false; ui.smartEditorId = null })
    }
}

/** Debug-only launch hooks for screenshots: extras `tab`, `route` (podcast|episode|bookmarks|latest|starred), `play`, `player`, `speed`. */
@Composable
private fun DebugHooks(nav: AppNav, ui: AppUi) {
    if (!app.homecast.android.BuildConfig.DEBUG) return
    val activity = androidx.activity.compose.LocalActivity.current ?: return
    val graph = LocalGraph.current
    LaunchedEffect(Unit) {
        val i = activity.intent
        i.getStringExtra("tab")?.let { nav.tab(it) }
        i.getStringExtra("route")?.let { r ->
            kotlinx.coroutines.delay(4000)
            val pods = graph.library.subscribedPodcasts().first()
            when (r) {
                "podcast" -> pods.firstOrNull { it.title.startsWith("Signal") }?.let { nav.podcast(it.id) }
                "episode" -> graph.library.latestEpisodes(1).first().firstOrNull()?.let { nav.episode(it.id) }
                "bookmarks" -> nav.bookmarks()
                "latest" -> nav.latest()
                "starred" -> nav.starred()
            }
        }
        if (i.hasExtra("download")) {
            kotlinx.coroutines.delay(4000)
            graph.library.latestEpisodes(2).first().forEach { graph.downloads.enqueue(it.id) }
        }
        if (i.hasExtra("play") || i.hasExtra("player")) {
            kotlinx.coroutines.delay(5000)
            val eps = graph.library.latestEpisodes(4).first()
            if (i.hasExtra("play")) {
                eps.drop(1).forEach { graph.library.enqueue(it.id, app.homecast.contract.QueuePosition.Last) }
                eps.firstOrNull()?.let { graph.player.play(it.id) }
                kotlinx.coroutines.delay(3000)
                graph.player.seekTo(47_000)
                i.getStringExtra("speed")?.toDoubleOrNull()?.let { graph.player.setSpeed(it, app.homecast.contract.SpeedScope.Podcast) }
            }
            if (i.hasExtra("bookmark")) { graph.player.addBookmarkAtCurrent("Router post office", "Great analogy for queues") }
            if (i.hasExtra("player")) { kotlinx.coroutines.delay(1500); ui.showPlayer = true }
        }
    }
}
