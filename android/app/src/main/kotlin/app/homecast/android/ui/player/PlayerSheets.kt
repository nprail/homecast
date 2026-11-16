package app.homecast.android.ui.player

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.Artwork
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.Fmt
import app.homecast.contract.PlayerState
import app.homecast.contract.SleepMode
import app.homecast.contract.SpeedScope
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

// ---- Speed ----------------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun SpeedSheet(st: PlayerState, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val scheme = MaterialTheme.colorScheme
    val hasPodcast = st.podcast != null
    var scope by rememberSaveable { mutableStateOf(if (hasPodcast) SpeedScope.Podcast else SpeedScope.Global) }
    var value by remember { mutableFloatStateOf(((st.speed * 10).roundToInt() / 10f)) }
    // Follow external changes (e.g. clear override) when not editing.
    LaunchedEffect(st.speed) { value = ((st.speed * 10).roundToInt() / 10f) }
    fun apply(v: Float) { value = v; graph.player.setSpeed(((v * 10).roundToInt() / 10.0), scope) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Playback speed", style = MaterialTheme.typography.titleMedium, color = scheme.onSurfaceVariant)
            Text(Fmt.speed(value.toDouble()), style = MaterialTheme.typography.displayMedium, color = if (st.speedIsOverride) scheme.tertiary else scheme.primary)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { apply((value - 0.1f).coerceAtLeast(0.5f)) }) { Icon(Icons.Filled.Remove, "Slower") }
                Slider(
                    value = value, onValueChange = { value = (it * 10).roundToInt() / 10f },
                    onValueChangeFinished = { apply(value) },
                    valueRange = 0.5f..3.0f, steps = 24, modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { apply((value + 0.1f).coerceAtMost(3.0f)) }) { Icon(Icons.Filled.Add, "Faster") }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), modifier = Modifier.fillMaxWidth()) {
                listOf(0.8f, 1.0f, 1.2f, 1.5f, 1.75f, 2.0f, 2.5f).forEach { p ->
                    FilterChip(selected = kotlin.math.abs(value - p) < 0.01f, onClick = { apply(p) }, label = { Text(Fmt.speed(p.toDouble()).let { if (p == 1.75f) "1.75×" else it }) })
                }
            }
            if (hasPodcast) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SegmentedButton(scope == SpeedScope.Podcast, { scope = SpeedScope.Podcast }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("This podcast") }
                    SegmentedButton(scope == SpeedScope.Global, { scope = SpeedScope.Global }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("All podcasts") }
                }
                Text(
                    if (scope == SpeedScope.Podcast) "Remembered for ${st.podcast?.title}." else "Used as the default for every podcast without its own speed.",
                    style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                )
            }
            if (st.speedIsOverride) {
                OutlinedButton(onClick = { graph.player.clearSpeedOverride() }, colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.tertiary)) {
                    Icon(Icons.Outlined.RestartAlt, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Clear this podcast's speed")
                }
            }
        }
    }
}

// ---- Sleep ----------------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun SleepSheet(st: PlayerState, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val scheme = MaterialTheme.colorScheme
    var custom by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Sleep timer", style = MaterialTheme.typography.titleLarge)
            val sleep = st.sleep
            if (sleep !is SleepMode.Off) {
                Surface(color = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer, shape = MaterialTheme.shapes.large) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(Icons.Filled.Bedtime, null)
                        Column(Modifier.weight(1f)) {
                            when (sleep) {
                                is SleepMode.Timer -> {
                                    val now by rememberNow()
                                    Text("Stops in ${Fmt.sleepRemaining(maxOf(0L, sleep.endsAtMs - now))}", style = MaterialTheme.typography.titleMedium)
                                }
                                else -> Text("Stops at the end of this episode", style = MaterialTheme.typography.titleMedium)
                            }
                        }
                        TextButton(onClick = { graph.player.extendSleep(5) }) { Text("+5 min") }
                    }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(5, 15, 30, 45, 60).forEach { m ->
                    FilledTonalButton(onClick = { graph.player.setSleepTimer(m); onDismiss() }) { Text("$m min") }
                }
                FilledTonalButton(onClick = { graph.player.setSleep(SleepMode.EndOfEpisode); onDismiss() }) { Text("End of episode") }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    custom, { custom = it.filter(Char::isDigit).take(4) }, Modifier.weight(1f), singleLine = true,
                    label = { Text("Custom minutes") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Button(onClick = { custom.toIntOrNull()?.takeIf { it > 0 }?.let { graph.player.setSleepTimer(it); onDismiss() } }, enabled = (custom.toIntOrNull() ?: 0) > 0) { Text("Start") }
            }
            if (st.sleep !is SleepMode.Off) {
                OutlinedButton(onClick = { graph.player.setSleep(SleepMode.Off); onDismiss() }, Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = scheme.error)) { Text("Turn off timer") }
            }
        }
    }
}

// ---- Up Next (compact, in the player) -------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UpNextSheet(st: PlayerState, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val queue by remember { graph.library.queue() }.collectAsStateWithLifecycle(emptyList())
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Up Next", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            if (queue.isNotEmpty()) TextButton(onClick = { scope.launch { graph.library.setQueue(emptyList()) } }) { Text("Clear") }
        }
        if (queue.isEmpty()) {
            EmptyState(Icons.Outlined.QueueMusic, "Nothing queued", "Add episodes from any list with “Add to Up Next”.")
        } else LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
            items(queue, key = { it.id }) { item ->
                val current = item.id == st.episode?.id
                ListItem(
                    headlineContent = { Text(item.episode.title, maxLines = 2, overflow = TextOverflow.Ellipsis, color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface) },
                    supportingContent = { Text(listOfNotNull(item.podcast?.title, Fmt.duration(item.remainingSec).ifEmpty { null }).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Artwork(item.podcast?.imageUrl, Modifier.size(48.dp), cornerRadius = 10.dp) },
                    trailingContent = {
                        if (current) Icon(Icons.Filled.GraphicEq, "Now playing", tint = MaterialTheme.colorScheme.primary)
                        else IconButton(onClick = { scope.launch { graph.library.dequeue(item.id) } }) { Icon(Icons.Outlined.Close, "Remove from Up Next") }
                    },
                    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.clickable { if (!current) graph.player.play(item.id) else graph.player.toggle() },
                )
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

// ---- Playlist picker ------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlaylistPickerSheet(episodeId: String, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val playlists by remember { graph.library.playlists() }.collectAsStateWithLifecycle(emptyList())
    var creating by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text("Add to playlist", Modifier.padding(horizontal = 24.dp, vertical = 4.dp), style = MaterialTheme.typography.titleLarge)
            if (creating) {
                Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Playlist name") })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), modifier = Modifier.fillMaxWidth()) {
                        TextButton(onClick = { creating = false }) { Text("Cancel") }
                        Button(enabled = name.isNotBlank(), onClick = {
                            val n = name.trim()
                            scope.launch(kotlinx.coroutines.NonCancellable) { graph.library.createPlaylist(n, listOf(episodeId)); ui.toast("Added to $n") }
                            onDismiss()
                        }) { Text("Create") }
                    }
                }
            } else {
                ListItem(
                    headlineContent = { Text("New playlist…") },
                    leadingContent = { Icon(Icons.Filled.Add, null, tint = MaterialTheme.colorScheme.primary) },
                    colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.clickable { creating = true },
                )
                playlists.forEach { p ->
                    val has = episodeId in p.episodeIds
                    ListItem(
                        headlineContent = { Text(p.name) },
                        supportingContent = { Text(if (has) "Already in this playlist" else Fmt.plural(p.episodeIds.size, "episode")) },
                        leadingContent = { Icon(Icons.Outlined.PlaylistPlay, null) },
                        trailingContent = { if (has) Icon(Icons.Filled.Check, null, tint = MaterialTheme.colorScheme.primary) },
                        colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                        modifier = Modifier.clickable(enabled = !has) {
                            scope.launch(kotlinx.coroutines.NonCancellable) { graph.library.addToPlaylist(p.id, episodeId); ui.toast("Added to ${p.name}") }
                            onDismiss()
                        },
                    )
                }
                if (playlists.isEmpty()) Text("No playlists yet.", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
