package app.homecast.android.ui.queue

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.EpisodeRow
import app.homecast.android.ui.components.Fmt
import app.homecast.android.ui.components.SectionLabel
import app.homecast.contract.EpisodeItem
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch

@Composable
private fun PlayAllBar(items: List<EpisodeItem>, label: String) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { items.firstOrNull()?.let { graph.player.play(it.id, items.map { i -> i.id }, label); ui.showPlayer = true } }, enabled = items.isNotEmpty()) {
            Icon(Icons.Filled.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)); Text("Play all")
        }
        FilledTonalButton(
            enabled = items.any { !it.downloaded },
            onClick = {
                val todo = items.filter { !it.downloaded }
                todo.forEach { graph.downloads.enqueue(it.id) }
                scope.launch { ui.toast("Downloading ${Fmt.plural(todo.size, "episode")}") }
            },
        ) { Icon(Icons.Outlined.DownloadForOffline, null, Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)); Text("Download all") }
        Spacer(Modifier.weight(1f))
        Text(Fmt.plural(items.size, "episode"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistScreen(id: String, nav: AppNav) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val data by remember(id) { graph.library.playlist(id) }.collectAsStateWithLifecycle(null)
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    val pl = data

    // Playlist deleted (here or on another device): leave.
    var seen by remember { mutableStateOf(false) }
    LaunchedEffect(pl) { if (pl != null) seen = true else if (seen) nav.back() }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(pl?.playlist?.name ?: "Playlist", maxLines = 1) },
                navigationIcon = { IconButton(onClick = nav::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More options") }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem({ Text("Rename") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; rename = true })
                            DropdownMenuItem({ Text("Delete playlist") }, leadingIcon = { Icon(Icons.Outlined.Delete, null) }, onClick = { menu = false; delete = true })
                        }
                    }
                },
            )
        },
    ) { pad ->
        if (pl == null) { Box(Modifier.padding(pad).fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }; return@Scaffold }
        val label = pl.playlist.name
        Column(Modifier.padding(pad).fillMaxSize()) {
            PlayAllBar(pl.items, label)
            if (pl.items.isEmpty()) Box(Modifier.fillMaxSize(), Alignment.Center) {
                EmptyState(Icons.Outlined.PlaylistAdd, "Empty playlist", "Use “Add to playlist…” on any episode.")
            } else ReorderableEpisodeList(
                pl.items, listLabel = label, modifier = Modifier.fillMaxSize(),
                onCommit = { ids -> scope.launch(NonCancellable) { graph.library.setPlaylistEpisodes(id, ids) } },
                onRemove = { item -> scope.launch(NonCancellable) { graph.library.setPlaylistEpisodes(id, pl.items.map { it.id }.filter { it != item.id }) } },
            )
        }
    }
    if (rename && pl != null) NameDialog("Rename playlist", pl.playlist.name, "Save", onDismiss = { rename = false }) { n -> scope.launch(NonCancellable) { graph.library.renamePlaylist(id, n) } }
    if (delete) ConfirmDialog("Delete playlist?", "The playlist is removed. Its episodes stay in your library.", "Delete", onDismiss = { delete = false }) {
        scope.launch(NonCancellable) { graph.library.deletePlaylist(id) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SmartPlaylistScreen(id: String, nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val data by remember(id) { graph.library.smartPlaylist(id) }.collectAsStateWithLifecycle(null)
    val podcasts by remember { graph.library.subscribedPodcasts() }.collectAsStateWithLifecycle(emptyList())
    val names = remember(podcasts) { podcasts.associate { it.id to it.title } }
    var delete by remember { mutableStateOf(false) }
    val sp = data
    var seen by remember { mutableStateOf(false) }
    LaunchedEffect(sp) { if (sp != null) seen = true else if (seen) nav.back() }
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(sp?.definition?.name ?: "Smart playlist", maxLines = 1) },
                navigationIcon = { IconButton(onClick = nav::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    IconButton(onClick = { ui.smartEditorId = id; ui.showSmartEditor = true }) { Icon(Icons.Outlined.Edit, "Edit rules") }
                    IconButton(onClick = { delete = true }) { Icon(Icons.Outlined.Delete, "Delete smart playlist") }
                },
                scrollBehavior = scroll,
            )
        },
    ) { pad ->
        if (sp == null) { Box(Modifier.padding(pad).fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }; return@Scaffold }
        val d = sp.definition
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            item {
                Card(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        SectionLabel(if (d.rules.isEmpty()) "Rules" else "Matches ${if (d.match == app.homecast.contract.SmartMatch.All) "all" else "any"} of")
                        if (d.rules.isEmpty()) Text("No rules: every episode matches.", style = MaterialTheme.typography.bodyMedium)
                        d.rules.forEach { Text("•  " + describeRule(it, names), style = MaterialTheme.typography.bodyMedium) }
                        Text(
                            "Sorted ${sortLabel(d.sort)}" + (d.limit?.let { ", up to $it episodes" } ?: "") + if (d.autoDownload == true) " · auto-downloads results" else "",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            item { PlayAllBar(sp.items, d.name) }
            if (sp.items.isEmpty()) item { EmptyState(Icons.Outlined.AutoAwesome, "Nothing matches yet", "New episodes that fit the rules show up here automatically.") }
            items(sp.items, key = { it.id }) { item ->
                EpisodeRow(item, onClick = { nav.episode(item.id) }, listIds = sp.items.map { it.id }, listLabel = d.name, modifier = Modifier.animateItem())
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
    if (delete) ConfirmDialog("Delete smart playlist?", "Only the rules are deleted. No episodes are removed.", "Delete", onDismiss = { delete = false }) {
        scope.launch(NonCancellable) { graph.library.deleteSmartPlaylist(id) }
    }
}
