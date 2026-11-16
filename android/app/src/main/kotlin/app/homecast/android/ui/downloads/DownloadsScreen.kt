package app.homecast.android.ui.downloads

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.*
import app.homecast.android.ui.components.*
import app.homecast.android.ui.library.SwipeAction
import app.homecast.android.ui.library.SwipeActionBox
import app.homecast.contract.*
import kotlinx.coroutines.launch

private val capOptions = listOf(0, 1000, 2000, 5000, 10000)
private fun capLabel(mb: Int) = if (mb == 0) "Unlimited" else "${mb / 1000} GB"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadsScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lib = graph.library
    val scope = rememberCoroutineScope()
    val downloads by remember(lib) { lib.downloads() }.collectAsStateWithLifecycle(emptyList())
    val bytes by remember(lib) { lib.downloadedBytes() }.collectAsStateWithLifecycle(0L)
    val active by graph.downloads.active.collectAsStateWithLifecycle()
    val errors by graph.downloads.errors.collectAsStateWithLifecycle()
    val device by graph.downloads.deviceSettings.collectAsStateWithLifecycle()
    var confirmAll by remember { mutableStateOf(false) }
    var capMenu by remember { mutableStateOf(false) }
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    val activeIds = active.keys.sorted()
    val activeItems by produceState(emptyList<EpisodeItem>(), activeIds) {
        value = try { lib.getEpisodeItems(activeIds) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { emptyList() }
    }
    val ids = remember(downloads) { downloads.map { it.id } }
    val cs = MaterialTheme.colorScheme

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0),
        topBar = {
            LargeTopAppBar(
                title = { Text("Downloads") }, scrollBehavior = scroll,
                actions = { if (downloads.isNotEmpty()) IconButton(onClick = { confirmAll = true }) { Icon(Icons.Outlined.DeleteSweep, "Remove all downloads") } },
            )
        },
    ) { inner ->
        Box(Modifier.padding(inner).fillMaxSize(), Alignment.TopCenter) {
            LazyColumn(Modifier.widthIn(max = 840.dp).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "storage") {
                    Card(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), colors = CardDefaults.cardColors(containerColor = cs.surfaceContainer)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Column(Modifier.weight(1f)) {
                                    SectionLabel("Storage")
                                    Text(Fmt.bytes(bytes), style = MaterialTheme.typography.headlineMedium)
                                }
                                Text(Fmt.plural(downloads.size, "episode"), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                            }
                            if (device.storageCapMb > 0) {
                                val cap = device.storageCapMb * 1_000_000L
                                LinearProgressIndicator(progress = { (bytes.toFloat() / cap).coerceIn(0f, 1f) }, Modifier.fillMaxWidth())
                                Text("${Fmt.bytes(bytes)} of ${capLabel(device.storageCapMb)}", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                            }
                            HorizontalDivider(color = cs.outlineVariant)
                            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("Download on Wi-Fi only", style = MaterialTheme.typography.bodyLarge)
                                    Text("Saves mobile data.", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                                }
                                Switch(checked = device.wifiOnly, onCheckedChange = { graph.downloads.updateDeviceSettings(device.copy(wifiOnly = it)) })
                            }
                            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("Storage limit", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                                Box {
                                    TextButton(onClick = { capMenu = true }) { Text(capLabel(device.storageCapMb)); Icon(Icons.Outlined.ArrowDropDown, null) }
                                    DropdownMenu(capMenu, { capMenu = false }) {
                                        capOptions.forEach { mb -> DropdownMenuItem({ Text(capLabel(mb)) }, onClick = { capMenu = false; graph.downloads.updateDeviceSettings(device.copy(storageCapMb = mb)) }) }
                                    }
                                }
                            }
                        }
                    }
                }
                if (active.isNotEmpty()) {
                    item(key = "active-label") { SectionLabel("In progress", Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)) }
                    items(activeIds, key = { "a-$it" }) { id ->
                        val item = activeItems.firstOrNull { it.id == id }
                        val p = active[id] ?: -1f
                        ListItem(
                            headlineContent = { Text(item?.episode?.title ?: "Episode", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = {
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    if (p >= 0f) LinearProgressIndicator(progress = { p }, Modifier.fillMaxWidth()) else LinearProgressIndicator(Modifier.fillMaxWidth())
                                    Text(errors[id] ?: if (p >= 0f) "${(p * 100).toInt()}%" else "Waiting to start", style = MaterialTheme.typography.bodySmall, color = if (errors.containsKey(id)) cs.error else cs.onSurfaceVariant)
                                }
                            },
                            leadingContent = { Artwork(item?.podcast?.imageUrl, Modifier.size(48.dp), cornerRadius = 10.dp) },
                            trailingContent = { IconButton(onClick = { graph.downloads.cancel(id) }) { Icon(Icons.Filled.Close, "Cancel download") } },
                        )
                    }
                }
                item(key = "done-label") { SectionLabel("Downloaded", Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)) }
                if (downloads.isEmpty()) item(key = "empty") {
                    EmptyState(Icons.Outlined.DownloadForOffline, "No downloads", "Download episodes to listen without a connection. You can also auto-download from a podcast's menu.")
                }
                items(downloads, key = { "d-${it.id}" }) { item ->
                    SwipeActionBox(
                        start = null,
                        end = SwipeAction(Icons.Outlined.Delete, "Remove", cs.errorContainer, cs.onErrorContainer) {
                            graph.downloads.remove(item.id); scope.launch { ui.toast("Download removed") }
                        },
                    ) { EpisodeRow(item, onClick = { nav.episode(item.id) }, listIds = ids, listLabel = "Downloads") }
                }
            }
        }
    }

    if (confirmAll) AlertDialog(
        onDismissRequest = { confirmAll = false },
        title = { Text("Remove all downloads?") },
        text = { Text("This frees ${Fmt.bytes(bytes)}. Episodes stay in your library and can be downloaded again.") },
        confirmButton = { TextButton(onClick = { confirmAll = false; graph.downloads.removeAll(); scope.launch { ui.toast("Downloads removed") } }) { Text("Remove all", color = cs.error) } },
        dismissButton = { TextButton(onClick = { confirmAll = false }) { Text("Cancel") } },
    )
}

