package app.homecast.android.ui.podcast

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.*
import app.homecast.android.ui.components.*
import app.homecast.android.ui.library.SwipeEpisodeRow
import app.homecast.contract.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

private class Loaded<T>(val value: T)
private enum class EpFilter(val label: String) { All("All"), Unplayed("Unplayed"), Downloaded("Downloaded") }
private enum class Dialog { AutoDownload, Cleanup, Speed, Unsubscribe }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PodcastScreen(podcastId: String, nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lib = graph.library
    val scope = rememberCoroutineScope()
    val podcast by remember(lib, podcastId) { lib.podcast(podcastId) }.collectAsStateWithLifecycle(null)
    val subLoaded by remember(lib, podcastId) { lib.subscription(podcastId).map { Loaded(it) } }.collectAsStateWithLifecycle(null)
    val episodes by remember(lib, podcastId) { lib.episodesForPodcast(podcastId) }.collectAsStateWithLifecycle(null)
    val settings by remember(lib) { lib.settings() }.collectAsStateWithLifecycle(UserSettings())
    val player by graph.player.state.collectAsStateWithLifecycle()

    var filter by rememberSaveable { mutableStateOf(EpFilter.All) }
    var oldestFirst by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<Dialog?>(null) }
    var subscribing by remember { mutableStateOf(false) }

    val sub = subLoaded?.value
    val speed = settings.podcastSpeeds[podcastId]
    val cleanup = settings.cleanupDays[podcastId]

    fun subscribe() {
        if (subscribing) return
        subscribing = true
        scope.launch {
            try {
                graph.remote.subscribe(podcastId); lib.ensureSubscriptionLocal(podcastId)
                launch { runCatching { graph.sync.sync() } }
                ui.toast("Subscribed")
            } catch (e: CancellationException) { throw e } catch (e: OfflineException) { ui.toast("You need a connection to subscribe") } catch (e: Exception) { ui.toast(e.message ?: "Couldn't subscribe") }
            subscribing = false
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (sub != null) Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More options") }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem({ Text("Auto-download") }, leadingIcon = { Icon(Icons.Outlined.DownloadForOffline, null) }, onClick = { menu = false; dialog = Dialog.AutoDownload })
                            DropdownMenuItem({ Text("Delete played after…") }, leadingIcon = { Icon(Icons.Outlined.AutoDelete, null) }, onClick = { menu = false; dialog = Dialog.Cleanup })
                            DropdownMenuItem({ Text("Playback speed") }, leadingIcon = { Icon(Icons.Outlined.Speed, null) }, onClick = { menu = false; dialog = Dialog.Speed })
                            HorizontalDivider()
                            DropdownMenuItem({ Text("Unsubscribe", color = MaterialTheme.colorScheme.error) }, leadingIcon = { Icon(Icons.Outlined.RemoveCircleOutline, null, tint = MaterialTheme.colorScheme.error) }, onClick = { menu = false; dialog = Dialog.Unsubscribe })
                        }
                    }
                },
            )
        },
    ) { inner ->
        val p = podcast
        val all = episodes
        if (p == null || all == null) {
            Box(Modifier.padding(inner).fillMaxSize(), Alignment.Center) {
                if (p == null && all != null) EmptyState(Icons.Outlined.Podcasts, "Podcast not found", "It may have been removed.") else CircularProgressIndicator()
            }
            return@Scaffold
        }
        val shown = remember(all, filter, oldestFirst) {
            val f = when (filter) {
                EpFilter.All -> all
                EpFilter.Unplayed -> all.filter { it.status != PlayStatus.Played }
                EpFilter.Downloaded -> all.filter { it.downloaded }
            }
            if (oldestFirst) f.sortedBy { it.episode.releasedAt } else f.sortedByDescending { it.episode.releasedAt }
        }
        val ids = remember(shown) { shown.map { it.id } }
        val resume = all.filter { it.status == PlayStatus.InProgress }.maxByOrNull { it.state?.positionUpdatedAt ?: 0L }
        val target = resume ?: all.filter { it.status == PlayStatus.Unplayed }.maxByOrNull { it.episode.releasedAt } ?: all.maxByOrNull { it.episode.releasedAt }

        Box(Modifier.padding(inner).fillMaxSize(), Alignment.TopCenter) {
            LazyColumn(Modifier.widthIn(max = 840.dp).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "header") {
                    Header(
                        p, subscribed = sub != null, subKnown = subLoaded != null, speed = speed, subscribing = subscribing,
                        playLabel = when { target == null -> null; resume != null -> "Resume" else -> "Play latest" },
                        playing = target != null && player.episode?.id == target.id && player.isPlaying,
                        onPlay = {
                            val t = target ?: return@Header
                            if (player.episode?.id == t.id) graph.player.toggle() else graph.player.play(t.id, ids.ifEmpty { null }, p.title)
                        },
                        onSubscribe = ::subscribe, onSpeed = { dialog = Dialog.Speed },
                    )
                }
                item(key = "filters") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            EpFilter.entries.forEach { f -> FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label, maxLines = 1, softWrap = false) }) }
                        }
                        TextButton(onClick = { oldestFirst = !oldestFirst }) {
                            Icon(Icons.Outlined.SwapVert, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp)); Text(if (oldestFirst) "Oldest" else "Newest")
                        }
                    }
                }
                if (shown.isEmpty()) item(key = "empty") {
                    EmptyState(Icons.Outlined.Podcasts, if (all.isEmpty()) "No episodes yet" else "Nothing here", if (all.isEmpty()) "Episodes appear after the feed has been fetched." else "No episodes match this filter.", Modifier.padding(vertical = 0.dp))
                }
                items(shown, key = { it.id }) { SwipeEpisodeRow(it, onClick = { nav.episode(it.id) }, listIds = ids, listLabel = p.title, showPodcast = false, showArtwork = false) }
            }
        }

        when (dialog) {
            Dialog.AutoDownload -> {
                val cur = sub?.autoDownload?.let { if (it.mode == AutoDownloadMode.Latest) AutoDownload(AutoDownloadMode.Latest, it.count ?: 1) else AutoDownload(it.mode) } ?: AutoDownload()
                ChoiceDialog(
                    "Auto-download",
                    listOf("Off" to AutoDownload(AutoDownloadMode.Off)) + listOf(1, 3, 5).map { "Latest ${Fmt.plural(it, "episode")}" to AutoDownload(AutoDownloadMode.Latest, it) } + ("All new episodes" to AutoDownload(AutoDownloadMode.All)),
                    cur, { v -> dialog = null; scope.launch { lib.setAutoDownload(podcastId, v); graph.downloads.runAutoDownloads() } }, { dialog = null },
                )
            }
            Dialog.Cleanup -> ChoiceDialog(
                "Delete played downloads after",
                listOf("Never" to null) + listOf(1, 3, 7, 14, 30).map { Fmt.plural(it, "day") to it },
                cleanup, { v -> dialog = null; scope.launch { lib.setCleanupDays(podcastId, v); graph.downloads.cleanup() } }, { dialog = null },
            )
            Dialog.Speed -> ChoiceDialog(
                "Playback speed",
                listOf("Default (${Fmt.speed(settings.defaultSpeed)})" to null) + listOf(1.0, 1.2, 1.5, 1.8, 2.0).map { Fmt.speed(it) to it },
                speed, { v -> dialog = null; scope.launch { lib.setPodcastSpeed(podcastId, v); graph.player.refreshSpeed() } }, { dialog = null },
            )
            Dialog.Unsubscribe -> AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("Unsubscribe from ${p.title}?") },
                text = { Text("Episodes will be removed from your library and downloads for this podcast may be deleted.") },
                confirmButton = { TextButton(onClick = { dialog = null; scope.launch { lib.unsubscribe(podcastId); nav.back(); ui.toast("Unsubscribed") } }) { Text("Unsubscribe", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
            )
            null -> {}
        }
    }
}

@Composable
private fun Header(
    p: Podcast, subscribed: Boolean, subKnown: Boolean, speed: Double?, subscribing: Boolean,
    playLabel: String?, playing: Boolean, onPlay: () -> Unit, onSubscribe: () -> Unit, onSpeed: () -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val desc = remember(p.summary) { Fmt.plainText(p.summary) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(p.imageUrl, Modifier.size(132.dp), cornerRadius = 20.dp, contentDescription = p.title)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(p.title, style = MaterialTheme.typography.headlineSmall, maxLines = 4, overflow = TextOverflow.Ellipsis)
                if (p.author.isNotBlank()) Text(p.author, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (p.isPrivate) AssistChip(onClick = {}, label = { Text("Private feed") }, leadingIcon = { Icon(Icons.Outlined.Lock, null, Modifier.size(16.dp)) })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (playLabel != null) Button(onClick = onPlay, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text(if (playing) "Pause" else playLabel)
            }
            if (subKnown && !subscribed) FilledTonalButton(onClick = onSubscribe, enabled = !subscribing, modifier = Modifier.heightIn(min = 48.dp)) {
                if (subscribing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Subscribe") }
            }
            if (speed != null) AssistChip(
                onClick = onSpeed, label = { Text("Plays at ${Fmt.speed(speed)}") }, leadingIcon = { Icon(Icons.Outlined.Speed, null, Modifier.size(18.dp)) },
                colors = AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer, labelColor = MaterialTheme.colorScheme.onTertiaryContainer, leadingIconContentColor = MaterialTheme.colorScheme.tertiary),
                border = null,
            )
        }
        if (desc.isNotBlank()) Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.animateContentSize(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(desc, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
            Text(if (expanded) "Show less" else "More", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun <T> ChoiceDialog(title: String, options: List<Pair<String, T>>, selected: T, onSelect: (T) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.selectableGroup()) {
                options.forEach { (label, value) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = value == selected, onClick = { onSelect(value) }, role = Role.RadioButton).padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = value == selected, onClick = null)
                        Spacer(Modifier.width(14.dp))
                        Text(label, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
