package app.homecast.android.ui.queue

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EpisodeRow
import app.homecast.contract.EpisodeItem

/**
 * A list of episodes with a drag handle (reorder) and swipe-to-remove. The visible order is a local copy so dragging is
 * instant; [onCommit] receives the new id order when a drag ends, and the source Flow then re-emits the saved order.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReorderableEpisodeList(
    items: List<EpisodeItem>,
    listLabel: String,
    onCommit: (List<String>) -> Unit,
    onRemove: (EpisodeItem) -> Unit,
    modifier: Modifier = Modifier,
    header: (LazyListScope.() -> Unit)? = null,
    onPlay: ((EpisodeItem, List<String>) -> Unit)? = null,
) {
    val graph = LocalGraph.current
    val order = remember { mutableStateListOf<EpisodeItem>().also { it.addAll(items) } }
    var draggingKey by remember { mutableStateOf<String?>(null) }
    var delta by remember { mutableFloatStateOf(0f) }
    val listState = rememberLazyListState()
    LaunchedEffect(items) { if (draggingKey == null) { order.clear(); order.addAll(items) } }

    fun swapIfNeeded() {
        val key = draggingKey ?: return
        val visible = listState.layoutInfo.visibleItemsInfo
        val cur = visible.firstOrNull { it.key == key } ?: return
        val center = cur.offset + cur.size / 2f + delta
        val target = visible.firstOrNull { it.key != key && it.key is String && order.any { o -> o.id == it.key } && center >= it.offset && center <= it.offset + it.size } ?: return
        val from = order.indexOfFirst { it.id == key }
        val to = order.indexOfFirst { it.id == target.key }
        if (from < 0 || to < 0) return
        order.add(to, order.removeAt(from))
        delta += cur.offset - target.offset
    }

    LazyColumn(modifier, state = listState, userScrollEnabled = draggingKey == null) {
        header?.invoke(this)
        items(order, key = { it.id }) { item ->
            val dragging = draggingKey == item.id
            val idx = order.indexOfFirst { it.id == item.id }
            val dismiss = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
                if (v == SwipeToDismissBoxValue.EndToStart) { order.removeAll { it.id == item.id }; onRemove(item); true } else false
            })
            SwipeToDismissBox(
                dismiss, enableDismissFromStartToEnd = false, gesturesEnabled = draggingKey == null,
                backgroundContent = {
                    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer).padding(horizontal = 24.dp), contentAlignment = Alignment.CenterEnd) {
                        Icon(Icons.Outlined.Delete, "Remove", tint = MaterialTheme.colorScheme.onErrorContainer)
                    }
                },
                modifier = Modifier
                    .zIndex(if (dragging) 1f else 0f)
                    .graphicsLayer { translationY = if (dragging) delta else 0f }
                    .then(if (dragging) Modifier else Modifier.animateItem()),
            ) {
                Surface(color = if (dragging) MaterialTheme.colorScheme.surfaceContainerHighest else MaterialTheme.colorScheme.background, shadowElevation = if (dragging) 8.dp else 0.dp) {
                    Row(
                        Modifier.semantics {
                            customActions = listOf(
                                CustomAccessibilityAction("Move up") { if (idx > 0) { order.add(idx - 1, order.removeAt(idx)); onCommit(order.map { it.id }); true } else false },
                                CustomAccessibilityAction("Move down") { if (idx in 0 until order.lastIndex) { order.add(idx + 1, order.removeAt(idx)); onCommit(order.map { it.id }); true } else false },
                            )
                        },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        EpisodeRow(
                            item, onClick = { val ids = order.map { it.id }; if (onPlay != null) onPlay(item, ids) else graph.player.play(item.id, ids, listLabel) }, modifier = Modifier.weight(1f),
                            listIds = order.map { it.id }, listLabel = listLabel,
                        )
                        Icon(
                            Icons.Filled.DragHandle, "Reorder",
                            Modifier.size(48.dp).padding(12.dp).pointerInput(item.id) {
                                detectDragGestures(
                                    onDragStart = { draggingKey = item.id; delta = 0f },
                                    onDrag = { change, amount -> change.consume(); delta += amount.y; swapIfNeeded() },
                                    onDragEnd = { draggingKey = null; delta = 0f; onCommit(order.map { it.id }) },
                                    onDragCancel = { draggingKey = null; delta = 0f },
                                )
                            },
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        item(key = "__bottom") { Spacer(Modifier.height(24.dp)) }
    }
}
