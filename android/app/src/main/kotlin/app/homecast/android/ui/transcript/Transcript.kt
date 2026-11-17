package app.homecast.android.ui.transcript

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.Fmt
import app.homecast.android.ui.share.shareMoment
import app.homecast.contract.ApiException
import app.homecast.contract.OfflineException
import app.homecast.contract.TranscriptSegment
import app.homecast.contract.TranscriptStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private sealed interface TState {
    data object Loading : TState
    data class Loaded(val status: TranscriptStatus, val error: String? = null) : TState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TranscriptScreen(episodeId: String, nav: AppNav) {
    val graph = LocalGraph.current
    val episode by remember(episodeId) { graph.library.episode(episodeId) }.collectAsStateWithLifecycle(null)
    var search by rememberSaveable { mutableStateOf(false) }
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Transcript", style = MaterialTheme.typography.titleLarge)
                        episode?.let { Text(it.episode.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                },
                navigationIcon = { IconButton(onClick = nav::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { IconButton(onClick = { search = !search }) { Icon(if (search) Icons.Filled.SearchOff else Icons.Filled.Search, if (search) "Close search" else "Search transcript") } },
            )
        },
    ) { pad -> TranscriptBody(episodeId, Modifier.padding(pad).fillMaxSize(), showSearch = search) }
}

/** Embedded in the full-screen player in place of the artwork. */
@Composable
fun TranscriptPanel(episodeId: String, modifier: Modifier = Modifier) {
    var search by rememberSaveable { mutableStateOf(false) }
    Box(modifier) {
        TranscriptBody(episodeId, Modifier.fillMaxSize(), showSearch = search)
        SmallFloatingActionButton(
            onClick = { search = !search }, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp),
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface,
        ) { Icon(if (search) Icons.Filled.SearchOff else Icons.Filled.Search, if (search) "Close search" else "Search transcript") }
    }
}

@Composable
private fun TranscriptBody(episodeId: String, modifier: Modifier, showSearch: Boolean) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var state by remember(episodeId) { mutableStateOf<TState>(TState.Loading) }
    var busy by remember(episodeId) { mutableStateOf(false) }

    suspend fun load(request: Boolean) {
        busy = true
        state = try {
            TState.Loaded(if (request) graph.remote.requestTranscript(episodeId) else graph.remote.loadTranscript(episodeId))
        } catch (e: CancellationException) { throw e
        } catch (e: OfflineException) { TState.Loaded(TranscriptStatus.Offline)
        } catch (e: ApiException) { TState.Loaded(TranscriptStatus.None, e.message)
        } catch (e: Exception) { TState.Loaded(TranscriptStatus.None, e.message) }
        busy = false
    }
    LaunchedEffect(episodeId) { load(false) }
    // Poll while generation is in flight.
    val pending = (state as? TState.Loaded)?.status is TranscriptStatus.Pending
    LaunchedEffect(episodeId, pending) { if (pending) while (true) { delay(8000); load(false) } }

    Box(modifier) {
        when (val s = state) {
            TState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            is TState.Loaded -> when (val st = s.status) {
                is TranscriptStatus.Ready -> TranscriptLines(episodeId, st.transcript.segments, showSearch)
                TranscriptStatus.None -> Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) {
                    EmptyState(Icons.Outlined.Subject, "No transcript yet", s.error ?: "Generate one on your server. It takes a few minutes and anyone on this server can then read along.") {
                        Button(onClick = { scope.launch { load(true) } }, enabled = !busy) {
                            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Icon(Icons.Filled.AutoAwesome, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp)); Text("Generate transcript")
                        }
                    }
                }
                TranscriptStatus.Offline -> Column(Modifier.fillMaxSize(), Arrangement.Center, Alignment.CenterHorizontally) {
                    EmptyState(Icons.Outlined.CloudOff, "You're offline", "Transcripts that haven't been saved to this device need a connection.") {
                        OutlinedButton(onClick = { scope.launch { load(false) } }, enabled = !busy) { Text("Try again") }
                    }
                }
                is TranscriptStatus.Pending -> Column(Modifier.fillMaxSize().padding(32.dp), Arrangement.Center, Alignment.CenterHorizontally, ) {
                    val p = st.progress
                    if (p != null) CircularProgressIndicator(progress = { p.toFloat().coerceIn(0f, 1f) }, Modifier.size(56.dp)) else CircularProgressIndicator(Modifier.size(56.dp))
                    Spacer(Modifier.height(16.dp))
                    Text("Generating transcript…", style = MaterialTheme.typography.titleMedium)
                    val detail = listOfNotNull(
                        st.stage?.replaceFirstChar { it.uppercase() },
                        p?.let { "${(it * 100).toInt().coerceIn(0, 100)}%" },
                        st.queuePosition?.let { "Queue position $it" },
                    ).joinToString(" · ")
                    if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(12.dp))
                    TextButton(onClick = { scope.launch { load(false) } }, enabled = !busy) { Icon(Icons.Filled.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Refresh") }
                }
            }
        }
    }
}

@Composable
private fun TranscriptLines(episodeId: String, segments: List<TranscriptSegment>, showSearch: Boolean) {
    val graph = LocalGraph.current
    val player by graph.player.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val isCurrent = player.episode?.id == episodeId
    var query by rememberSaveable { mutableStateOf("") }
    var matchIdx by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()
    val q = query.trim()
    val matches = remember(segments, q) { if (q.length < 2) emptyList() else segments.indices.filter { segments[it].text.contains(q, ignoreCase = true) } }
    LaunchedEffect(q) { matchIdx = 0; if (matches.isNotEmpty()) listState.animateScrollToItem(matches[0]) }

    // Index of the segment being spoken: last one whose start <= position. Derived so we only recompose on change.
    val currentIdx by remember(segments, isCurrent) {
        derivedStateOf {
            if (!isCurrent) -1 else {
                val pos = player.positionMs
                var lo = 0; var hi = segments.size - 1; var ans = -1
                while (lo <= hi) { val mid = (lo + hi) ushr 1; if (segments[mid].startMs <= pos) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
                ans
            }
        }
    }
    // Follow along unless the user is searching or dragging the list.
    val dragging by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(currentIdx) {
        if (currentIdx >= 0 && q.isEmpty() && !dragging) listState.animateScrollToItem((currentIdx - 1).coerceAtLeast(0))
    }

    val context = androidx.compose.ui.platform.LocalContext.current
    val shareItem by remember(episodeId) { graph.library.episode(episodeId) }.collectAsStateWithLifecycle(null)
    Column(Modifier.fillMaxSize()) {
        if (showSearch) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    query, { query = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("Search this episode") },
                    leadingIcon = { Icon(Icons.Filled.Search, null) },
                    trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear search") } },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), shape = MaterialTheme.shapes.extraLarge,
                )
                if (matches.isNotEmpty()) {
                    Text("${matchIdx + 1}/${matches.size}", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium)
                    IconButton(onClick = { matchIdx = (matchIdx - 1 + matches.size) % matches.size; scope.launch { listState.animateScrollToItem(matches[matchIdx]) } }) { Icon(Icons.Filled.KeyboardArrowUp, "Previous match") }
                    IconButton(onClick = { matchIdx = (matchIdx + 1) % matches.size; scope.launch { listState.animateScrollToItem(matches[matchIdx]) } }) { Icon(Icons.Filled.KeyboardArrowDown, "Next match") }
                } else if (q.length >= 2) Text("No matches", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (segments.isEmpty()) {
            EmptyState(Icons.Outlined.Subject, "Empty transcript", "This transcript has no text.")
            return@Column
        }
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 12.dp)) {
            itemsIndexed(segments, key = { i, s -> "$i-${s.startMs}" }) { i, seg ->
                val active = i == currentIdx
                val highlighted = matches.isNotEmpty() && i == matches.getOrNull(matchIdx)
                Surface(
                    color = when { active -> MaterialTheme.colorScheme.primaryContainer; highlighted -> MaterialTheme.colorScheme.surfaceContainerHighest; else -> androidx.compose.ui.graphics.Color.Transparent },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 1.dp).clickable(onClickLabel = "Play from ${Fmt.clock(seg.startMs)}") {
                        if (isCurrent) graph.player.seekTo(seg.startMs)
                        else { graph.player.play(episodeId); graph.player.seekTo(seg.startMs) }
                    },
                ) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(Fmt.clock(seg.startMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.width(44.dp).padding(top = 3.dp))
                        Text(
                            highlight(seg.text, q), style = MaterialTheme.typography.bodyLarge,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (active) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                        if (active || highlighted) IconButton(
                            onClick = { shareItem?.let { context.shareMoment(graph.session.serverUrl, episodeId, it.episode.title, it.podcast?.title, seg.startMs, seg.text) } },
                            Modifier.size(36.dp),
                        ) { Icon(Icons.Outlined.Share, "Share this line", Modifier.size(20.dp)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun highlight(text: String, q: String): AnnotatedString {
    if (q.length < 2) return AnnotatedString(text)
    val bg = MaterialTheme.colorScheme.tertiaryContainer
    val fg = MaterialTheme.colorScheme.onTertiaryContainer
    return buildAnnotatedString {
        var from = 0
        while (true) {
            val i = text.indexOf(q, from, ignoreCase = true)
            if (i < 0) { append(text.substring(from)); break }
            append(text.substring(from, i))
            withStyle(SpanStyle(background = bg, color = fg, fontWeight = FontWeight.Bold)) { append(text.substring(i, i + q.length)) }
            from = i + q.length
        }
    }
}
