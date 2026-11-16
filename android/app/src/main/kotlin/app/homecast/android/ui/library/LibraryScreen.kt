package app.homecast.android.ui.library

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.*
import app.homecast.android.ui.components.*
import app.homecast.contract.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class EpisodeListKind { Latest, Starred }

private fun String?.orFallback(fallback: String) = this?.takeIf { it.isNotBlank() } ?: fallback

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lib = graph.library
    val scope = rememberCoroutineScope()
    val podcasts by remember(lib) { lib.subscribedPodcasts() }.collectAsStateWithLifecycle(null)
    val unplayed by remember(lib) { lib.unplayedCounts() }.collectAsStateWithLifecycle(emptyMap())
    val inProgress by remember(lib) { lib.continueListening(8) }.collectAsStateWithLifecycle(emptyList())
    val bookmarkCount by remember(lib) { lib.bookmarkCount() }.collectAsStateWithLifecycle(0)
    val starredCount by remember(lib) { lib.starredCount() }.collectAsStateWithLifecycle(0)
    val sync by graph.sync.state.collectAsStateWithLifecycle()
    var refreshing by remember { mutableStateOf(false) }
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0),
        topBar = {
            LargeTopAppBar(
                title = { Text("Library") },
                scrollBehavior = scroll,
                actions = {
                    SyncChip(sync) { scope.launch { runCatching { graph.sync.sync() } } }
                    IconButton(onClick = { ui.showAddPodcast = true }) { Icon(Icons.Filled.Add, "Add a podcast") }
                },
            )
        },
    ) { inner ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; try { graph.sync.sync() } catch (e: CancellationException) { throw e } catch (_: Exception) {} finally { refreshing = false } } },
            modifier = Modifier.padding(inner).fillMaxSize(),
        ) {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(148.dp),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item(key = "links", span = { GridItemSpan(maxLineSpan) }) { QuickLinks(nav, bookmarkCount, starredCount) }
                if (inProgress.isNotEmpty()) {
                    item(key = "continue", span = { GridItemSpan(maxLineSpan) }) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            SectionLabel("Continue listening")
                            val ids = inProgress.map { it.id }
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(end = 16.dp)) {
                                items(inProgress, key = { it.id }) { ContinueCard(it, ids, nav) }
                            }
                        }
                    }
                }
                val list = podcasts
                when {
                    list == null -> item(key = "loading", span = { GridItemSpan(maxLineSpan) }) {
                        Box(Modifier.fillMaxWidth().padding(48.dp), Alignment.Center) { CircularProgressIndicator() }
                    }
                    list.isEmpty() -> item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                        EmptyState(Icons.Outlined.Podcasts, "No podcasts yet", "Add a podcast by feed URL, import an OPML file, or browse Discover.") {
                            Button(onClick = { ui.showAddPodcast = true }) { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Add a podcast") }
                            OutlinedButton(onClick = { nav.tab("discover") }) { Text("Browse Discover") }
                        }
                    }
                    else -> {
                        item(key = "podcasts-label", span = { GridItemSpan(maxLineSpan) }) { SectionLabel("Podcasts") }
                        items(list, key = { "p-${it.id}" }) { p -> PodcastTile(p, unplayed[p.id] ?: 0) { nav.podcast(p.id) } }
                    }
                }
            }
        }
    }
}

@Composable
private fun SyncChip(state: SyncState, onRetry: () -> Unit) {
    when (state.status) {
        SyncStatus.Idle -> {}
        SyncStatus.Syncing -> AssistChip(
            onClick = {}, label = { Text("Syncing") },
            leadingIcon = { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) },
        )
        SyncStatus.Offline -> AssistChip(onClick = onRetry, label = { Text("Offline") }, leadingIcon = { Icon(Icons.Outlined.CloudOff, null, Modifier.size(18.dp)) })
        SyncStatus.Error -> AssistChip(
            onClick = onRetry, label = { Text("Sync problem") },
            leadingIcon = { Icon(Icons.Outlined.SyncProblem, null, Modifier.size(18.dp)) },
            colors = AssistChipDefaults.assistChipColors(containerColor = MaterialTheme.colorScheme.errorContainer, labelColor = MaterialTheme.colorScheme.onErrorContainer, leadingIconContentColor = MaterialTheme.colorScheme.onErrorContainer),
            border = null,
        )
    }
    Spacer(Modifier.width(4.dp))
}

@Composable
private fun QuickLinks(nav: AppNav, bookmarks: Int, starred: Int) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
        val transparent = ListItemDefaults.colors(containerColor = Color.Transparent)
        @Composable
        fun row(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, label: String, count: Int?, onClick: () -> Unit) = ListItem(
            headlineContent = { Text(label) },
            leadingContent = { Icon(icon, null, tint = tint) },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (count != null) Text(count.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            colors = transparent,
            modifier = Modifier.clickable(onClick = onClick),
        )
        row(Icons.Outlined.NewReleases, MaterialTheme.colorScheme.primary, "Latest episodes", null) { nav.latest() }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
        row(Icons.Outlined.ManageSearch, MaterialTheme.colorScheme.primary, "Search transcripts", null) { nav.searchTranscripts() }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
        row(Icons.Outlined.Bookmarks, MaterialTheme.colorScheme.tertiary, "Bookmarks", bookmarks) { nav.bookmarks() }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
        row(Icons.Outlined.StarOutline, MaterialTheme.colorScheme.tertiary, "Starred", starred) { nav.starred() }
    }
}

@Composable
private fun ContinueCard(item: EpisodeItem, ids: List<String>, nav: AppNav) {
    val graph = LocalGraph.current
    val player by graph.player.state.collectAsStateWithLifecycle()
    val isPlaying = player.episode?.id == item.id && player.isPlaying
    ElevatedCard(
        onClick = { nav.episode(item.id) },
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        modifier = Modifier.width(290.dp),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Artwork(item.podcast?.imageUrl, Modifier.size(64.dp), cornerRadius = 12.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(item.podcast?.title.orEmpty(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(item.episode.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ProgressTrack(item.progress)
                    Text("${Fmt.duration(item.remainingSec)} left", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FilledTonalIconButton(onClick = { if (player.episode?.id == item.id) graph.player.toggle() else graph.player.play(item.id, ids, "Continue listening") }) {
                    Icon(if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (isPlaying) "Pause" else "Resume ${item.episode.title}")
                }
            }
        }
    }
}

@Composable
private fun PodcastTile(p: Podcast, unplayed: Int, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box {
            Artwork(p.imageUrl, Modifier.fillMaxWidth(), cornerRadius = 18.dp, contentDescription = p.title)
            if (unplayed > 0) Badge(Modifier.align(Alignment.TopEnd).padding(8.dp), containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) {
                Text(if (unplayed > 99) "99+" else unplayed.toString())
            }
        }
        Text(p.title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

// ---- Flat episode lists (Latest / Starred) ------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EpisodeListScreen(kind: EpisodeListKind, nav: AppNav) {
    val lib = LocalGraph.current.library
    val items by remember(lib, kind) { if (kind == EpisodeListKind.Latest) lib.latestEpisodes(100) else lib.starredEpisodes() }.collectAsStateWithLifecycle(null)
    val title = if (kind == EpisodeListKind.Latest) "Latest episodes" else "Starred"
    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { inner ->
        val list = items
        Box(Modifier.padding(inner).fillMaxSize(), Alignment.TopCenter) {
            when {
                list == null -> CircularProgressIndicator(Modifier.padding(48.dp))
                list.isEmpty() -> EmptyState(
                    if (kind == EpisodeListKind.Latest) Icons.Outlined.NewReleases else Icons.Outlined.StarOutline,
                    if (kind == EpisodeListKind.Latest) "Nothing new yet" else "No starred episodes",
                    if (kind == EpisodeListKind.Latest) "New episodes from your podcasts will show up here." else "Star an episode from its menu to keep it handy.",
                )
                else -> {
                    val ids = remember(list) { list.map { it.id } }
                    LazyColumn(Modifier.widthIn(max = 840.dp).fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                        items(list, key = { it.id }) { SwipeEpisodeRow(it, onClick = { nav.episode(it.id) }, listIds = ids, listLabel = title) }
                    }
                }
            }
        }
    }
}

// ---- Add podcast ---------------------------------------------------------------------------------------------------

private fun friendly(e: Throwable): String = when (e) {
    is OfflineException -> "You need a connection to add a podcast"
    is ApiException -> e.message.orFallback("The server rejected that request.")
    else -> e.message.orFallback("Something went wrong. Try again.")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddPodcastSheet(onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by rememberSaveable { mutableStateOf("") }
    var private by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // The sheet leaves composition on success, so confirmation + sync run in a scope that outlives it.
    fun finish(message: String) {
        onDismiss()
        MainScope().launch {
            launch { runCatching { graph.sync.sync() } }
            ui.toast(message)
        }
    }

    fun add() {
        val feed = url.trim()
        if (feed.isEmpty() || busy) return
        busy = true; error = null
        scope.launch {
            try {
                val (_, title) = graph.remote.addPodcast(feed, private)
                finish("Added $title")
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = friendly(e); busy = false }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true; error = null
        scope.launch {
            try {
                val text = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } } ?: throw IllegalStateException("Couldn't read that file.")
                val r = graph.remote.importOpml(text)
                finish(r.summary)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = friendly(e); busy = false }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Add a podcast", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = url, onValueChange = { url = it; error = null },
                label = { Text("Feed URL") }, placeholder = { Text("https://example.com/feed.xml") },
                singleLine = true, enabled = !busy, isError = error != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { add() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Private feed", style = MaterialTheme.typography.bodyLarge)
                    Text("Only you can see this podcast.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = private, onCheckedChange = { private = it }, enabled = !busy)
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(onClick = ::add, enabled = url.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Add podcast")
            }
            OutlinedButton(
                onClick = { picker.launch(arrayOf("text/x-opml", "text/xml", "application/xml", "text/plain", "application/octet-stream", "*/*")) },
                enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Icon(Icons.Outlined.FileOpen, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Import OPML file") }
        }
    }
}
