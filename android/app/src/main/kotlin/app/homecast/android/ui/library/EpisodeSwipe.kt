package app.homecast.android.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.PlaylistAdd
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EpisodeRow
import app.homecast.contract.EpisodeItem
import app.homecast.contract.PlayStatus
import app.homecast.contract.QueuePosition
import kotlinx.coroutines.launch

class SwipeAction(val icon: ImageVector, val label: String, val container: Color, val content: Color, val onTrigger: () -> Unit)

/** Swipe-to-act wrapper: the row always snaps back; the action runs once the swipe is confirmed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SwipeActionBox(start: SwipeAction?, end: SwipeAction?, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val startRef by rememberUpdatedState(start)
    val endRef by rememberUpdatedState(end)
    val state = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        when (v) {
            SwipeToDismissBoxValue.StartToEnd -> startRef?.onTrigger()
            SwipeToDismissBoxValue.EndToStart -> endRef?.onTrigger()
            SwipeToDismissBoxValue.Settled -> {}
        }
        false
    })
    SwipeToDismissBox(
        state = state,
        modifier = modifier,
        enableDismissFromStartToEnd = start != null,
        enableDismissFromEndToStart = end != null,
        backgroundContent = {
            val dir = state.dismissDirection
            val action = when (dir) { SwipeToDismissBoxValue.StartToEnd -> start; SwipeToDismissBoxValue.EndToStart -> end; else -> null }
            Box(
                Modifier.fillMaxSize().background(action?.container ?: Color.Transparent).padding(horizontal = 24.dp),
                contentAlignment = if (dir == SwipeToDismissBoxValue.StartToEnd) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                if (action != null) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(action.icon, null, tint = action.content)
                    Text(action.label, style = MaterialTheme.typography.labelSmall, color = action.content)
                }
            }
        },
    ) { Box(Modifier.background(MaterialTheme.colorScheme.background)) { content() } }
}

/** EpisodeRow with swipe start = Play next, swipe end = mark played / unplayed. */
@Composable
fun SwipeEpisodeRow(
    item: EpisodeItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    listIds: List<String> = emptyList(),
    listLabel: String = "Up Next",
    showPodcast: Boolean = true,
    showArtwork: Boolean = true,
) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val cs = MaterialTheme.colorScheme
    val played = item.status == PlayStatus.Played
    SwipeActionBox(
        start = SwipeAction(Icons.Outlined.PlaylistAdd, "Play next", cs.primaryContainer, cs.onPrimaryContainer) {
            scope.launch { graph.library.enqueue(item.id, QueuePosition.Next, graph.player.state.value.episode?.id); ui.toast("Playing next") }
        },
        end = SwipeAction(
            if (played) Icons.Outlined.RadioButtonUnchecked else Icons.Outlined.CheckCircle,
            if (played) "Unplayed" else "Played", cs.secondaryContainer, cs.onSecondaryContainer,
        ) { scope.launch { if (played) graph.library.markUnplayed(item.id) else graph.library.markPlayed(item.id) } },
        modifier = modifier,
    ) { EpisodeRow(item, onClick, Modifier, listIds, listLabel, showPodcast, showArtwork) }
}
