package app.homecast.android.ui.queue

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.PlaylistPlay
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.Fmt
import app.homecast.contract.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch

private enum class QueueTab(val label: String) { UpNext("Up Next"), Playlists("Playlists"), Smart("Smart") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(QueueTab.UpNext) }
    var createPlaylist by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val queue by remember { graph.library.queue() }.collectAsStateWithLifecycle(null)

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            LargeTopAppBar(
                title = { Text(if (tab == QueueTab.UpNext) "Up Next" else "Queue") },
                actions = {
                    when (tab) {
                        QueueTab.UpNext -> IconButton(onClick = { confirmClear = true }, enabled = !queue.isNullOrEmpty()) { Icon(Icons.Outlined.ClearAll, "Clear Up Next") }
                        QueueTab.Playlists -> IconButton(onClick = { createPlaylist = true }) { Icon(Icons.Filled.Add, "New playlist") }
                        QueueTab.Smart -> IconButton(onClick = { ui.smartEditorId = null; ui.showSmartEditor = true }) { Icon(Icons.Filled.Add, "New smart playlist") }
                    }
                },
                scrollBehavior = scroll,
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                QueueTab.entries.forEachIndexed { i, t ->
                    SegmentedButton(tab == t, { tab = t }, SegmentedButtonDefaults.itemShape(i, QueueTab.entries.size)) { Text(t.label) }
                }
            }
            when (tab) {
                QueueTab.UpNext -> UpNextTab(queue)
                QueueTab.Playlists -> PlaylistsTab(nav) { createPlaylist = true }
                QueueTab.Smart -> SmartTab(nav)
            }
        }
    }
    if (createPlaylist) NameDialog("New playlist", "", "Create", onDismiss = { createPlaylist = false }) { name ->
        scope.launch(NonCancellable) { val id = graph.library.createPlaylist(name); nav.playlist(id) }
    }
    if (confirmClear) AlertDialog(
        onDismissRequest = { confirmClear = false },
        title = { Text("Clear Up Next?") }, text = { Text("This removes every episode from the queue. Nothing is deleted from your library.") },
        confirmButton = { TextButton(onClick = { confirmClear = false; scope.launch(NonCancellable) { graph.library.setQueue(emptyList()) } }) { Text("Clear") } },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
    )
}

@Composable
private fun UpNextTab(queue: List<EpisodeItem>?) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    when {
        queue == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        queue.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            EmptyState(Icons.Outlined.QueueMusic, "Your queue is empty", "Use “Play next” or “Add to Up Next” from any episode and it will line up here.")
        }
        else -> ReorderableEpisodeList(
            queue, listLabel = "Up Next", modifier = Modifier.fillMaxSize(),
            onCommit = { ids -> scope.launch(NonCancellable) { graph.library.setQueue(ids) } },
            onRemove = { scope.launch(NonCancellable) { graph.library.dequeue(it.id) } },
            header = {
                item(key = "__summary") {
                    val total = queue.sumOf { it.remainingSec }
                    Text(
                        "${Fmt.plural(queue.size, "episode")} · ${Fmt.duration(total).ifEmpty { "0 min" }} left. Drag the handle to reorder, swipe to remove.",
                        Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
        )
    }
}

@Composable
private fun PlaylistsTab(nav: AppNav, onCreate: () -> Unit) {
    val graph = LocalGraph.current
    val lists by remember { graph.library.playlists() }.collectAsStateWithLifecycle(null)
    val l = lists
    when {
        l == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        l.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            EmptyState(Icons.AutoMirrored.Outlined.PlaylistPlay, "No playlists", "Group episodes into hand-picked playlists, like a road-trip mix.") {
                FilledTonalButton(onClick = onCreate) { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("New playlist") }
            }
        }
        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(l, key = { it.id }) { p ->
                ListItem(
                    headlineContent = { Text(p.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(Fmt.plural(p.episodeIds.size, "episode")) },
                    leadingContent = { Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(48.dp)) { Box(contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Outlined.PlaylistPlay, null, tint = MaterialTheme.colorScheme.primary) } } },
                    trailingContent = { Icon(Icons.Filled.ChevronRight, null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable { nav.playlist(p.id) },
                )
            }
        }
    }
}

@Composable
private fun SmartTab(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lists by remember { graph.library.smartPlaylists() }.collectAsStateWithLifecycle(null)
    val podcasts by remember { graph.library.subscribedPodcasts() }.collectAsStateWithLifecycle(emptyList())
    val names = remember(podcasts) { podcasts.associate { it.id to it.title } }
    val l = lists
    when {
        l == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
        l.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            EmptyState(Icons.Outlined.AutoAwesome, "No smart playlists", "Smart playlists fill themselves from rules, like “unplayed, under 30 minutes”.") {
                FilledTonalButton(onClick = { ui.smartEditorId = null; ui.showSmartEditor = true }) { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("New smart playlist") }
            }
        }
        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(l, key = { it.id }) { s ->
                ListItem(
                    headlineContent = { Text(s.definition.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text("${Fmt.plural(s.matchCount, "match")} · ${summarize(s.definition, names)}", maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.size(48.dp)) { Box(contentAlignment = Alignment.Center) { Icon(Icons.Outlined.AutoAwesome, null, tint = MaterialTheme.colorScheme.tertiary) } } },
                    trailingContent = { Icon(Icons.Filled.ChevronRight, null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable { nav.smartPlaylist(s.id) },
                )
            }
        }
    }
}

// ---- Shared helpers -------------------------------------------------------------------------------------------

/** One-line, human description of a rule. */
internal fun describeRule(r: SmartRule, podcasts: Map<String, String>): String {
    fun names(ids: List<String>) = when {
        ids.isEmpty() -> "no podcasts"
        ids.size <= 2 -> ids.joinToString(" or ") { podcasts[it] ?: "unknown podcast" }
        else -> "${ids.size} podcasts"
    }
    fun num(d: Double) = if (d == Math.floor(d)) d.toInt().toString() else d.toString()
    return when (r) {
        is SmartRule.PodcastIn -> "Podcast is ${names(r.ids)}"
        is SmartRule.PodcastNotIn -> "Podcast is not ${names(r.ids)}"
        is SmartRule.Status -> "Status is " + when (r.status) { PlayStatus.Unplayed -> "unplayed"; PlayStatus.InProgress -> "in progress"; PlayStatus.Played -> "played" }
        is SmartRule.ReleasedWithin -> "Released within ${num(r.days)} ${if (r.days == 1.0) "day" else "days"}"
        is SmartRule.DurationLessThan -> "Shorter than ${num(r.minutes)} min"
        is SmartRule.DurationGreaterThan -> "Longer than ${num(r.minutes)} min"
        is SmartRule.Downloaded -> if (r.value) "Is downloaded" else "Is not downloaded"
        is SmartRule.Starred -> if (r.value) "Is starred" else "Is not starred"
        is SmartRule.TitleContains -> "Title contains “${r.text}”"
    }
}

internal fun sortLabel(s: SmartSort) = when (s.field) {
    SortField.ReleasedAt -> if (s.dir == SortDir.Desc) "newest first" else "oldest first"
    SortField.Duration -> if (s.dir == SortDir.Desc) "longest first" else "shortest first"
    SortField.Title -> if (s.dir == SortDir.Asc) "A to Z" else "Z to A"
}

internal fun summarize(d: SmartPlaylistDefinition, podcasts: Map<String, String>): String {
    val rules = if (d.rules.isEmpty()) "All episodes" else d.rules.joinToString(if (d.match == SmartMatch.All) " and " else " or ") { describeRule(it, podcasts).replaceFirstChar { c -> c.lowercase() } }
        .replaceFirstChar { it.uppercase() }
    return rules + ", ${sortLabel(d.sort)}" + (d.limit?.let { ", up to $it" } ?: "") + if (d.autoDownload == true) " · auto-downloads" else ""
}

/** Single text-field dialog used for create and rename. */
@Composable
internal fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var name by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss, title = { Text(title) },
        text = { OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.fillMaxWidth()) },
        confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onConfirm(name.trim()); onDismiss() }) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun ConfirmDialog(title: String, message: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss, title = { Text(title) }, text = { Text(message) },
        confirmButton = { TextButton(onClick = { onDismiss(); onConfirm() }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
