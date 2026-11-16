package app.homecast.android.ui.episode

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.*
import app.homecast.android.ui.components.*
import app.homecast.contract.*
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EpisodeScreen(episodeId: String, nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lib = graph.library
    val scope = rememberCoroutineScope()
    val item by remember(lib, episodeId) { lib.episode(episodeId) }.collectAsStateWithLifecycle(null)
    val bookmarks by remember(lib, episodeId) { lib.bookmarksForEpisode(episodeId) }.collectAsStateWithLifecycle(emptyList())
    val player by graph.player.state.collectAsStateWithLifecycle()
    val active by graph.downloads.active.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    item?.let { it ->
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More options") }
                            EpisodeMenu(it, menu) { menu = false }
                        }
                    }
                },
            )
        },
    ) { inner ->
        val it = item
        if (it == null) {
            Box(Modifier.padding(inner).fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        val isCurrent = player.episode?.id == it.id
        val isPlaying = isCurrent && player.isPlaying
        val dl = active[it.id]
        Box(Modifier.padding(inner).fillMaxSize(), Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Bottom) {
                    Artwork(it.podcast?.imageUrl, Modifier.size(120.dp), cornerRadius = 20.dp, contentDescription = it.podcast?.title)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        it.podcast?.let { p ->
                            Text(p.title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { nav.podcast(p.id) })
                        }
                        Text(
                            listOfNotNull(Fmt.released(it.episode.releasedAt), Fmt.duration(it.episode.durationSec).ifBlank { null }).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(it.episode.title, style = MaterialTheme.typography.headlineSmall)

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = { if (isCurrent) graph.player.toggle() else graph.player.play(it.id) },
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        Icon(if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, null, Modifier.size(22.dp)); Spacer(Modifier.width(8.dp))
                        Text(when { isPlaying -> "Pause"; it.status == PlayStatus.InProgress -> "Resume · ${Fmt.duration(it.remainingSec)} left"; else -> "Play" })
                    }
                    FilledTonalIconButton(onClick = { scope.launch { lib.enqueue(it.id, QueuePosition.Last); ui.toast("Added to Up Next") } }, modifier = Modifier.size(52.dp)) {
                        Icon(Icons.Outlined.PlaylistAdd, "Add to Up Next")
                    }
                    when {
                        it.downloaded -> FilledTonalIconButton(
                            onClick = { graph.downloads.remove(it.id); scope.launch { ui.toast("Download removed") } }, modifier = Modifier.size(52.dp),
                            colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.primary),
                        ) { Icon(Icons.Filled.DownloadDone, "Downloaded. Tap to remove") }
                        dl != null -> FilledTonalIconButton(onClick = { graph.downloads.cancel(it.id) }, modifier = Modifier.size(52.dp)) {
                            Box(contentAlignment = Alignment.Center) {
                                if (dl >= 0f) CircularProgressIndicator(progress = { dl }, Modifier.size(28.dp), strokeWidth = 3.dp) else CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                                Icon(Icons.Filled.Close, "Cancel download", Modifier.size(14.dp))
                            }
                        }
                        else -> FilledTonalIconButton(onClick = { graph.downloads.enqueue(it.id); scope.launch { ui.toast("Downloading") } }, modifier = Modifier.size(52.dp)) {
                            Icon(Icons.Outlined.Download, "Download")
                        }
                    }
                }
                if (it.status == PlayStatus.InProgress) ProgressTrack(it.progress)
                else if (it.status == PlayStatus.Played) Text("Played", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    ListItem(
                        headlineContent = { Text("Transcript") },
                        supportingContent = { Text(if (it.episode.hasPublisherTranscript) "From the publisher" else "Read along, or generate one") },
                        leadingContent = { Icon(Icons.Outlined.Subtitles, null, tint = MaterialTheme.colorScheme.primary) },
                        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.clickable { nav.transcript(it.id) },
                    )
                }

                if (bookmarks.isNotEmpty()) {
                    SectionLabel("Bookmarks")
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                        bookmarks.sortedBy { b -> b.positionMs }.forEachIndexed { i, b ->
                            if (i > 0) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
                            ListItem(
                                overlineContent = { Text(Fmt.clock(b.positionMs)) },
                                headlineContent = { Text(b.title?.takeIf { t -> t.isNotBlank() } ?: "Bookmark") },
                                supportingContent = b.note?.takeIf { n -> n.isNotBlank() }?.let { n -> { Text(n, maxLines = 3, overflow = TextOverflow.Ellipsis) } },
                                leadingContent = { Icon(Icons.Filled.Bookmark, null, tint = MaterialTheme.colorScheme.tertiary) },
                                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                                modifier = Modifier.clickable {
                                    if (isCurrent) { graph.player.seekTo(b.positionMs); if (!isPlaying) graph.player.resume() }
                                    else { graph.player.play(it.id); graph.player.seekTo(b.positionMs) }
                                },
                            )
                        }
                    }
                }

                val notes = remember(it.episode.summary) { Fmt.plainText(it.episode.summary) }
                if (notes.isNotBlank()) {
                    SectionLabel("Show notes")
                    Text(notes, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
