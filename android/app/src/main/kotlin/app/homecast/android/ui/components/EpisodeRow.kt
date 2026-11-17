package app.homecast.android.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.layout.size
import androidx.compose.ui.unit.sp
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.share.shareMoment
import app.homecast.contract.EpisodeItem
import app.homecast.contract.PlayStatus
import app.homecast.contract.QueuePosition
import kotlinx.coroutines.launch

/**
 * One episode in a list: artwork, podcast, title, meta (date, time left, status), progress, download state, play button.
 * [listIds] is the list this row belongs to so playback continues through it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun EpisodeRow(
    item: EpisodeItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    listIds: List<String> = emptyList(),
    listLabel: String = "Up Next",
    showPodcast: Boolean = true,
    showArtwork: Boolean = true,
) {
    val graph = LocalGraph.current
    val player by graph.player.state.collectAsStateWithLifecycle()
    val active by graph.downloads.active.collectAsStateWithLifecycle()
    val isCurrent = player.episode?.id == item.id
    val isPlaying = isCurrent && player.isPlaying
    var menu by remember { mutableStateOf(false) }

    Box(modifier) {
        Row(
            Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = { menu = true }).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (showArtwork) Artwork(item.podcast?.imageUrl, Modifier.size(64.dp), cornerRadius = 14.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                if (showPodcast && item.podcast != null) {
                    Text(item.podcast!!.title, style = MaterialTheme.typography.labelMedium, color = if (isCurrent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(
                    item.episode.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    color = if (item.status == PlayStatus.Played) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (item.status == PlayStatus.Unplayed) Box(Modifier.size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).semantics { contentDescription = "Unplayed" })
                    Text(meta(item), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (item.starred) Icon(Icons.Filled.Star, "Starred", Modifier.size(14.dp), tint = MaterialTheme.colorScheme.tertiary)
                    val p = active[item.id]
                    when {
                        item.downloaded -> Icon(Icons.Filled.DownloadForOffline, "Downloaded", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.primary)
                        p != null && p >= 0f -> CircularProgressIndicator(progress = { p }, Modifier.size(14.dp), strokeWidth = 2.dp)
                        p != null -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    }
                }
                if (item.status == PlayStatus.InProgress) ProgressTrack(item.progress, Modifier.widthIn(max = 160.dp).padding(top = 3.dp))
            }
            FilledTonalIconButton(
                onClick = { if (isCurrent) graph.player.toggle() else graph.player.play(item.id, listIds.ifEmpty { null }, listLabel) },
                colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.primary),
            ) { Icon(if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (isPlaying) "Pause" else "Play ${item.episode.title}") }
        }
        EpisodeMenu(item, expanded = menu, onDismiss = { menu = false })
    }
}

private fun meta(item: EpisodeItem): String {
    val parts = mutableListOf(Fmt.released(item.episode.releasedAt))
    if (item.status == PlayStatus.InProgress) parts += "${Fmt.duration(item.remainingSec)} left"
    else if (item.episode.durationSec > 0) parts += Fmt.duration(item.episode.durationSec)
    if (item.status == PlayStatus.Played) parts += "Played"
    return parts.joinToString(" · ")
}

/** Long-press / overflow menu: queue, playlist, played state, star, download. */
@Composable
fun EpisodeMenu(item: EpisodeItem, expanded: Boolean, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val active by graph.downloads.active.collectAsStateWithLifecycle()
    val playing = graph.player.state.value.episode?.id
    DropdownMenu(expanded, onDismiss) {
        fun act(msg: String? = null, block: suspend () -> Unit) { onDismiss(); scope.launch { block(); msg?.let { ui.toast(it) } } }
        DropdownMenuItem({ Text("Play next") }, leadingIcon = { Icon(Icons.Outlined.PlaylistAdd, null) }, onClick = { act("Playing next") { graph.library.enqueue(item.id, QueuePosition.Next, playing) } })
        DropdownMenuItem({ Text("Add to Up Next") }, leadingIcon = { Icon(Icons.Outlined.QueueMusic, null) }, onClick = { act("Added to Up Next") { graph.library.enqueue(item.id, QueuePosition.Last) } })
        DropdownMenuItem({ Text("Add to playlist…") }, leadingIcon = { Icon(Icons.Outlined.LibraryAdd, null) }, onClick = { onDismiss(); ui.playlistPickerEpisodeId = item.id })
        val context = androidx.compose.ui.platform.LocalContext.current
        val playingThis = playing == item.id
        DropdownMenuItem(
            { Text(if (playingThis) "Share this moment" else "Share episode") }, leadingIcon = { Icon(Icons.Outlined.Share, null) },
            onClick = { onDismiss(); context.shareMoment(graph.session.serverUrl, item.id, item.episode.title, item.podcast?.title, if (playingThis) graph.player.state.value.positionMs else null) },
        )
        HorizontalDivider()
        if (item.status == PlayStatus.Played) DropdownMenuItem({ Text("Mark as unplayed") }, leadingIcon = { Icon(Icons.Outlined.RadioButtonUnchecked, null) }, onClick = { act { graph.library.markUnplayed(item.id) } })
        else DropdownMenuItem({ Text("Mark as played") }, leadingIcon = { Icon(Icons.Outlined.CheckCircle, null) }, onClick = { act { graph.library.markPlayed(item.id) } })
        DropdownMenuItem({ Text(if (item.starred) "Remove star" else "Star") }, leadingIcon = { Icon(if (item.starred) Icons.Filled.Star else Icons.Outlined.StarOutline, null) }, onClick = { act { graph.library.setStarred(item.id, !item.starred) } })
        when {
            item.downloaded -> DropdownMenuItem({ Text("Remove download") }, leadingIcon = { Icon(Icons.Outlined.Delete, null) }, onClick = { act { graph.downloads.remove(item.id) } })
            active.containsKey(item.id) -> DropdownMenuItem({ Text("Cancel download") }, leadingIcon = { Icon(Icons.Outlined.Cancel, null) }, onClick = { act { graph.downloads.cancel(item.id) } })
            else -> DropdownMenuItem({ Text("Download") }, leadingIcon = { Icon(Icons.Outlined.DownloadForOffline, null) }, onClick = { act("Downloading") { graph.downloads.enqueue(item.id) } })
        }
    }
}
