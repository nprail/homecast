package app.homecast.android.ui.search

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ManageSearch
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.Fmt
import app.homecast.contract.OfflineException
import app.homecast.contract.TranscriptSearchItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Start a little before the matched line so the sentence is heard from its start. */
private const val LEAD_MS = 1500L
private const val MIN_CHARS = 2

private sealed interface Found {
    data object Idle : Found
    data object Loading : Found
    data class Results(val query: String, val items: List<TranscriptSearchItem>) : Found
    data class Failed(val message: String, val offline: Boolean) : Found
}

/** The words of a query; "quoted phrases" stay whole. Mirrors the server's rule. */
private fun terms(q: String): List<String> =
    Regex("\"([^\"]+)\"|(\\S+)").findAll(q).map { (it.groups[1]?.value ?: it.groups[2]?.value ?: "").trim() }.filter { it.isNotEmpty() }.toList()

private fun highlighted(text: String, q: String, color: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    val ranges = mutableListOf<IntRange>()
    for (t in terms(q)) {
        var from = 0
        while (true) {
            val i = text.indexOf(t, from, ignoreCase = true)
            if (i < 0) break
            ranges += i until i + t.length
            from = i + t.length
        }
    }
    // Merge overlaps so two terms hitting the same text don't style it twice.
    val merged = mutableListOf<IntRange>()
    for (r in ranges.sortedBy { it.first }) {
        val last = merged.lastOrNull()
        if (last != null && r.first <= last.last + 1) merged[merged.lastIndex] = last.first..maxOf(last.last, r.last) else merged += r
    }
    var pos = 0
    for (r in merged) {
        append(text.substring(pos, r.first))
        withStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold)) { append(text.substring(r.first, r.last + 1)) }
        pos = r.last + 1
    }
    append(text.substring(pos))
}

/** Search what was said across the transcripts of every podcast you follow. Runs on the server. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TranscriptSearchScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<Found>(Found.Idle) }
    val q = query.trim()

    LaunchedEffect(q) {
        if (q.length < MIN_CHARS) { found = Found.Idle; return@LaunchedEffect }
        delay(350)
        if (found !is Found.Results) found = Found.Loading
        found = try {
            Found.Results(q, graph.remote.searchTranscripts(q))
        } catch (e: CancellationException) { throw e
        } catch (e: OfflineException) { Found.Failed("Search needs a connection to the server.", offline = true)
        } catch (e: Exception) { Found.Failed(e.message ?: "Search failed.", offline = false) }
    }

    fun open(item: TranscriptSearchItem, startMs: Long) {
        scope.launch {
            graph.player.play(item.episodeId, label = "Search")
            graph.player.seekTo(maxOf(0L, startMs - LEAD_MS))
            nav.transcript(item.episodeId)
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = { TopAppBar(title = { Text("Search transcripts") }, navigationIcon = { IconButton(onClick = nav::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } }) },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize()) {
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                placeholder = { Text("What was said") },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear") } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = {}),
                shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            when (val f = found) {
                Found.Idle -> EmptyState(Icons.Outlined.ManageSearch, "Find a moment in any episode", "Only episodes that have a transcript are searched. Use quotes to match an exact phrase.")
                Found.Loading -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                is Found.Failed -> EmptyState(if (f.offline) Icons.Outlined.WifiOff else Icons.Outlined.SearchOff, if (f.offline) "You're offline" else "Search failed", f.message)
                is Found.Results ->
                    if (f.items.isEmpty()) EmptyState(Icons.Outlined.SearchOff, "No matches", "Try different words, or fewer of them.")
                    else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(f.items, key = { it.episodeId }) { item ->
                            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), shape = RoundedCornerShape(20.dp)) {
                                Column(Modifier.padding(14.dp)) {
                                    Column(Modifier.fillMaxWidth().clickable { nav.episode(item.episodeId) }) {
                                        Text(item.episodeTitle, style = MaterialTheme.typography.titleSmall, maxLines = 2)
                                        Text("${item.podcastTitle} · ${if (item.matches == 1) "1 match" else "${item.matches} matches"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    item.hits.forEach { h ->
                                        Row(
                                            Modifier.padding(top = 8.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { open(item, h.startMs) }.padding(horizontal = 10.dp, vertical = 8.dp),
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        ) {
                                            Text(Fmt.clock(h.startMs), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.width(48.dp))
                                            Text(highlighted(h.text, f.query, MaterialTheme.colorScheme.tertiary), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                        }
                                    }
                                    if (item.matches > item.hits.size) Text("+${item.matches - item.hits.size} more in the transcript", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
            }
        }
    }
}
