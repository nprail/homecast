package app.homecast.android.ui.queue

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.Fmt
import app.homecast.contract.*
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private enum class RuleKind(val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Podcast("Podcast", Icons.Outlined.Podcasts), Status("Status", Icons.Outlined.CheckCircle), Released("Released within", Icons.Outlined.Event),
    Duration("Duration", Icons.Outlined.Timer), Downloaded("Downloaded", Icons.Outlined.DownloadForOffline), Starred("Starred", Icons.Outlined.StarOutline),
    Title("Title contains", Icons.Outlined.TextFields);
    fun blank(): SmartRule = when (this) {
        Podcast -> SmartRule.PodcastIn(emptyList()); Status -> SmartRule.Status(PlayStatus.Unplayed); Released -> SmartRule.ReleasedWithin(7.0)
        Duration -> SmartRule.DurationLessThan(30.0); Downloaded -> SmartRule.Downloaded(true); Starred -> SmartRule.Starred(true); Title -> SmartRule.TitleContains("")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SmartPlaylistEditorSheet(existingId: String?, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val podcasts by remember { graph.library.subscribedPodcasts() }.collectAsStateWithLifecycle(emptyList())
    val names = remember(podcasts) { podcasts.associate { it.id to it.title } }

    var loaded by remember { mutableStateOf(existingId == null) }
    var name by rememberSaveable { mutableStateOf(if (existingId == null) SmartPlaylistDefinition.blank().name else "") }
    var match by rememberSaveable { mutableStateOf(SmartMatch.All) }
    val rules = remember { mutableStateListOf<SmartRule>().also { if (existingId == null) it.addAll(SmartPlaylistDefinition.blank().rules) } }
    var sort by remember { mutableStateOf(SmartPlaylistDefinition.blank().sort) }
    var limit by remember { mutableStateOf<Int?>(50) }
    var autoDownload by rememberSaveable { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    var matches by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(existingId) {
        if (existingId != null) {
            graph.library.smartPlaylist(existingId).first()?.definition?.let { d ->
                name = d.name; match = d.match; rules.clear(); rules.addAll(d.rules); sort = d.sort; limit = d.limit; autoDownload = d.autoDownload == true
            }
            loaded = true
        }
    }
    fun definition() = SmartPlaylistDefinition(name.trim().ifEmpty { "Smart playlist" }, match, rules.toList(), sort, limit, autoDownload)
    // Live "N matches" preview, debounced.
    LaunchedEffect(loaded, match, sort, limit, rules.toList()) {
        if (!loaded) return@LaunchedEffect
        delay(300)
        matches = runCatching { graph.library.evaluate(definition()).size }.getOrNull()
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.94f)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Text(if (existingId == null) "New smart playlist" else "Edit smart playlist", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Button(enabled = loaded && name.isNotBlank(), onClick = {
                    val d = definition()
                    scope.launch(NonCancellable) { runCatching { graph.library.saveSmartPlaylist(existingId, d) }.onFailure { ui.toast(it.message ?: "Couldn't save") } }
                    onDismiss()
                }) { Text("Save") }
            }
            if (!loaded) { Box(Modifier.fillMaxWidth().weight(1f), Alignment.Center) { CircularProgressIndicator() }; return@Column }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)

                Text("Match", style = MaterialTheme.typography.titleSmall)
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SegmentedButton(match == SmartMatch.All, { match = SmartMatch.All }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("All rules") }
                    SegmentedButton(match == SmartMatch.Any, { match = SmartMatch.Any }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Any rule") }
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Rules", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Box {
                        FilledTonalButton(onClick = { addMenu = true }) { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Add rule") }
                        DropdownMenu(addMenu, { addMenu = false }) {
                            RuleKind.entries.forEach { k -> DropdownMenuItem({ Text(k.label) }, leadingIcon = { Icon(k.icon, null) }, onClick = { addMenu = false; rules.add(k.blank()) }) }
                        }
                    }
                }
                if (rules.isEmpty()) Text("No rules: every episode in your library matches.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                rules.forEachIndexed { i, r ->
                    RuleCard(r, podcasts, onChange = { rules[i] = it }, onRemove = { rules.removeAt(i) })
                }

                Text("Sort & limit", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Picker("Sort by", sort.field, listOf(SortField.ReleasedAt to "Release date", SortField.Duration to "Duration", SortField.Title to "Title"), Modifier.weight(1f)) { sort = SmartSort(it, defaultDir(it)) }
                    Picker("Order", sort.dir, dirOptions(sort.field), Modifier.weight(1f)) { sort = sort.copy(dir = it) }
                }
                Picker("Limit", limit, listOf<Pair<Int?, String>>(null to "No limit") + listOf(10, 25, 50, 100, 200).map { it to "$it episodes" }, Modifier.fillMaxWidth()) { limit = it }

                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("Auto-download results", style = MaterialTheme.typography.bodyLarge)
                        Text("Keep matching episodes available offline.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(autoDownload, { autoDownload = it })
                }
                Surface(color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer, shape = MaterialTheme.shapes.medium) {
                    Text(
                        matches?.let { "${Fmt.plural(it, "episode")} match right now" } ?: "Checking matches…",
                        Modifier.fillMaxWidth().padding(14.dp), style = MaterialTheme.typography.labelLarge,
                    )
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

private fun defaultDir(f: SortField) = if (f == SortField.Title) SortDir.Asc else SortDir.Desc
private fun dirOptions(f: SortField): List<Pair<SortDir, String>> = when (f) {
    SortField.ReleasedAt -> listOf(SortDir.Desc to "Newest first", SortDir.Asc to "Oldest first")
    SortField.Duration -> listOf(SortDir.Desc to "Longest first", SortDir.Asc to "Shortest first")
    SortField.Title -> listOf(SortDir.Asc to "A to Z", SortDir.Desc to "Z to A")
}

/** Outlined dropdown selector. */
@Composable
private fun <T> Picker(label: String, value: T, options: List<Pair<T, String>>, modifier: Modifier = Modifier, onPick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedCard(onClick = { open = true }, Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(options.firstOrNull { it.first == value }?.second ?: "", style = MaterialTheme.typography.bodyLarge)
                }
                Icon(Icons.Filled.ArrowDropDown, null)
            }
        }
        DropdownMenu(open, { open = false }) { options.forEach { (v, l) -> DropdownMenuItem({ Text(l) }, onClick = { open = false; onPick(v) }, trailingIcon = { if (v == value) Icon(Icons.Filled.Check, null) }) } }
    }
}

@Composable
private fun Stepper(value: Double, step: Double, min: Double, unit: String, onChange: (Double) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        FilledTonalIconButton(onClick = { onChange((value - step).coerceAtLeast(min)) }, enabled = value > min) { Icon(Icons.Filled.Remove, "Decrease") }
        Text(
            (if (value == Math.floor(value)) value.toInt().toString() else value.toString()) + " " + unit,
            Modifier.widthIn(min = 80.dp), style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        FilledTonalIconButton(onClick = { onChange(value + step) }) { Icon(Icons.Filled.Add, "Increase") }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RuleCard(rule: SmartRule, podcasts: List<Podcast>, onChange: (SmartRule) -> Unit, onRemove: () -> Unit) {
    var pick by remember { mutableStateOf(false) }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (rule) {
                    is SmartRule.PodcastIn, is SmartRule.PodcastNotIn -> {
                        val ids = if (rule is SmartRule.PodcastIn) rule.ids else (rule as SmartRule.PodcastNotIn).ids
                        val inn = rule is SmartRule.PodcastIn
                        Text("Podcast", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(inn, { onChange(SmartRule.PodcastIn(ids)) }, label = { Text("is any of") })
                            FilterChip(!inn, { onChange(SmartRule.PodcastNotIn(ids)) }, label = { Text("is none of") })
                        }
                        OutlinedButton(onClick = { pick = true }) {
                            Text(if (ids.isEmpty()) "Choose podcasts…" else ids.joinToString(", ") { id -> podcasts.firstOrNull { it.id == id }?.title ?: "Unknown" }, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        }
                        if (pick) PodcastPickerDialog(podcasts, ids, onDismiss = { pick = false }) { sel -> onChange(if (inn) SmartRule.PodcastIn(sel) else SmartRule.PodcastNotIn(sel)) }
                    }
                    is SmartRule.Status -> {
                        Text("Status is", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(PlayStatus.Unplayed to "Unplayed", PlayStatus.InProgress to "In progress", PlayStatus.Played to "Played").forEach { (s, l) ->
                                FilterChip(rule.status == s, { onChange(SmartRule.Status(s)) }, label = { Text(l) })
                            }
                        }
                    }
                    is SmartRule.ReleasedWithin -> {
                        Text("Released within", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Stepper(rule.days, 1.0, 1.0, if (rule.days == 1.0) "day" else "days") { onChange(SmartRule.ReleasedWithin(it)) }
                    }
                    is SmartRule.DurationLessThan, is SmartRule.DurationGreaterThan -> {
                        val lt = rule is SmartRule.DurationLessThan
                        val mins = if (rule is SmartRule.DurationLessThan) rule.minutes else (rule as SmartRule.DurationGreaterThan).minutes
                        Text("Duration is", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(lt, { onChange(SmartRule.DurationLessThan(mins)) }, label = { Text("shorter than") })
                            FilterChip(!lt, { onChange(SmartRule.DurationGreaterThan(mins)) }, label = { Text("longer than") })
                        }
                        Stepper(mins, 5.0, 1.0, "min") { onChange(if (lt) SmartRule.DurationLessThan(it) else SmartRule.DurationGreaterThan(it)) }
                    }
                    is SmartRule.Downloaded -> BoolRule("Downloaded", rule.value) { onChange(SmartRule.Downloaded(it)) }
                    is SmartRule.Starred -> BoolRule("Starred", rule.value) { onChange(SmartRule.Starred(it)) }
                    is SmartRule.TitleContains -> OutlinedTextField(rule.text, { onChange(SmartRule.TitleContains(it)) }, Modifier.fillMaxWidth(), label = { Text("Title contains") }, singleLine = true)
                }
            }
            IconButton(onClick = onRemove) { Icon(Icons.Outlined.Close, "Remove rule") }
        }
    }
}

@Composable
private fun BoolRule(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(if (value) "Yes" else "No", style = MaterialTheme.typography.bodyLarge)
        }
        Switch(value, onChange)
    }
}

@Composable
private fun PodcastPickerDialog(podcasts: List<Podcast>, selected: List<String>, onDismiss: () -> Unit, onDone: (List<String>) -> Unit) {
    val sel = remember { mutableStateListOf<String>().also { it.addAll(selected) } }
    AlertDialog(
        onDismissRequest = onDismiss, title = { Text("Choose podcasts") },
        text = {
            if (podcasts.isEmpty()) Text("Subscribe to a podcast first.")
            else LazyColumn(Modifier.heightIn(max = 380.dp)) {
                items(podcasts, key = { it.id }) { p ->
                    Row(Modifier.fillMaxWidth().clickable { if (p.id in sel) sel.remove(p.id) else sel.add(p.id) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(p.id in sel, null, Modifier.padding(end = 12.dp))
                        Text(p.title, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onDone(sel.toList()); onDismiss() }) { Text("Done") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
