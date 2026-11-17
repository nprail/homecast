package app.homecast.android.ui.player

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import app.homecast.contract.Chapter
import app.homecast.android.ui.share.shareMoment
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.BookmarkTarget
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.Artwork
import app.homecast.android.ui.components.Fmt
import app.homecast.android.ui.components.EpisodeMenu
import app.homecast.android.ui.transcript.TranscriptPanel
import app.homecast.contract.PlayerState
import app.homecast.contract.CastState
import app.homecast.contract.SleepMode
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------------------------------------------
// Mini player
// ---------------------------------------------------------------------------------------------------------------

/** Compact player that sits above the navigation bar. Tap opens the full-screen player. */
@Composable
fun MiniPlayer(onOpen: () -> Unit) {
    val graph = LocalGraph.current
    val st by graph.player.state.collectAsStateWithLifecycle()
    val episode = st.episode ?: return
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        tonalElevation = 3.dp,
        modifier = Modifier.fillMaxWidth().clickable(onClickLabel = "Open player", onClick = onOpen),
    ) {
        Column {
            Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Artwork(st.podcast?.imageUrl ?: null, Modifier.size(46.dp), cornerRadius = 10.dp)
                Column(Modifier.weight(1f)) {
                    Text(episode.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        st.error ?: st.podcast?.title.orEmpty(), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (st.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    if (st.isBuffering && st.isPlaying) CircularProgressIndicator(Modifier.size(40.dp), strokeWidth = 2.dp)
                    IconButton(onClick = { graph.player.toggle() }) {
                        Icon(if (st.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (st.isPlaying) "Pause" else "Play", Modifier.size(30.dp))
                    }
                }
                IconButton(onClick = { graph.player.forward() }) { Icon(Icons.Filled.Forward30, "Forward 30 seconds") }
            }
            LinearProgressIndicator(
                progress = { st.progress }, modifier = Modifier.fillMaxWidth().height(2.dp),
                color = MaterialTheme.colorScheme.primary, trackColor = MaterialTheme.colorScheme.outlineVariant, gapSize = 0.dp, drawStopIndicator = {},
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Full-screen player
// ---------------------------------------------------------------------------------------------------------------

private enum class PlayerSheet { Speed, Sleep, Queue, Chapters, Cast }

@Composable
fun NowPlayingScreen(onClose: () -> Unit, nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val st by graph.player.state.collectAsStateWithLifecycle()
    val cast by graph.player.cast.collectAsStateWithLifecycle()
    val episode = st.episode
    var sheet by remember { mutableStateOf<PlayerSheet?>(null) }
    var showTranscript by rememberSaveable { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    var chapters by remember { mutableStateOf<List<Chapter>>(emptyList()) }
    LaunchedEffect(episode?.id) {
        chapters = emptyList()
        episode?.id?.let { chapters = graph.remote.chapters(it) }
    }
    val currentChapter = chapters.lastOrNull { it.startMs <= st.positionMs }

    Surface(Modifier.fillMaxSize(), color = scheme.background) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(scheme.primaryContainer.copy(alpha = 0.7f), scheme.background), endY = 1600f))) {
            if (episode == null) {
                Box(Modifier.fillMaxSize().safeDrawingPadding(), Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Nothing playing", style = MaterialTheme.typography.titleLarge)
                        TextButton(onClick = onClose) { Text("Close") }
                    }
                }
                return@Box
            }
            Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 24.dp)) {
                PlayerTopBar(st, onClose, nav)
                if (st.error != null) {
                    Surface(color = scheme.errorContainer, contentColor = scheme.onErrorContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(Icons.Filled.ErrorOutline, null)
                            Text(st.error.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { graph.player.resume() }) { Text("Retry") }
                        }
                    }
                }
                // Artwork or transcript
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    if (showTranscript) {
                        Surface(color = scheme.surfaceContainer.copy(alpha = 0.7f), shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxSize()) {
                            TranscriptPanel(episode.id, Modifier.fillMaxSize())
                        }
                    } else {
                        val side = minOf(maxWidth, maxHeight)
                        val scale by animateFloatAsState(if (st.isPlaying) 1f else 0.86f, spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow), label = "art-scale")
                        val corner by animateDpAsState(if (st.isPlaying) 28.dp else 44.dp, label = "art-corner")
                        Artwork(
                            st.podcast?.imageUrl,
                            Modifier.size(side).scale(scale).shadow(if (st.isPlaying) 18.dp else 4.dp, RoundedCornerShape(corner)),
                            cornerRadius = corner, contentDescription = "Artwork for ${st.podcast?.title ?: episode.title}",
                        )
                    }
                }
                // Title
                Column(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalAlignment = Alignment.Start) {
                    Text(episode.title, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (currentChapter != null) Text(currentChapter.title, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        st.podcast?.title.orEmpty(), style = MaterialTheme.typography.bodyLarge, color = scheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable(enabled = st.podcast != null) { st.podcast?.let { onClose(); nav.podcast(it.id) } },
                    )
                }
                AnimatedVisibility(st.isFading) {
                    Surface(
                        color = scheme.tertiaryContainer, contentColor = scheme.onTertiaryContainer, shape = MaterialTheme.shapes.large,
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp).clickable { graph.player.extendSleep() },
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(Icons.Filled.Bedtime, null, tint = scheme.tertiary)
                            Text("Sleep timer ending. Tap to add 5 min", style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                val bookmarks by remember(episode.id) { graph.library.bookmarksForEpisode(episode.id) }.collectAsStateWithLifecycle(emptyList())
                Scrubber(st, bookmarks.map { it.positionMs }, chapters.map { it.startMs }) { graph.player.seekTo(it) }
                Spacer(Modifier.height(4.dp))
                Transport(st)
                Spacer(Modifier.height(8.dp))
                ActionRow(st, cast, showTranscript, hasChapters = chapters.isNotEmpty(), onCast = { sheet = PlayerSheet.Cast }, onChapters = { sheet = PlayerSheet.Chapters }, onSpeed = { sheet = PlayerSheet.Speed }, onSleep = { sheet = PlayerSheet.Sleep }, onQueue = { sheet = PlayerSheet.Queue },
                    onBookmark = { ui.bookmarkTarget = BookmarkTarget(episode.id, graph.player.state.value.positionMs) },
                    onTranscript = { showTranscript = !showTranscript })
                Spacer(Modifier.height(12.dp))
            }
        }
    }
    when (sheet) {
        PlayerSheet.Speed -> SpeedSheet(st) { sheet = null }
        PlayerSheet.Sleep -> SleepSheet(st) { sheet = null }
        PlayerSheet.Queue -> UpNextSheet(st) { sheet = null }
        PlayerSheet.Cast -> CastSheet(cast) { sheet = null }
        PlayerSheet.Chapters -> ChaptersSheet(chapters, st.positionMs, onSeek = { graph.player.seekTo(it) }) { sheet = null }
        null -> {}
    }
}

@Composable
private fun PlayerTopBar(st: PlayerState, onClose: () -> Unit, nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val episode = st.episode ?: return
    val item by remember(episode.id) { graph.library.episode(episode.id) }.collectAsStateWithLifecycle(null)
    var menu by remember { mutableStateOf(false) }
    var actions by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(64.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onClose) { Icon(Icons.Filled.KeyboardArrowDown, "Close player", Modifier.size(32.dp)) }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("PLAYING FROM", style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 1.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(st.context.label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More options") }
            DropdownMenu(menu, { menu = false }) {
                st.podcast?.let { p -> DropdownMenuItem({ Text("Go to podcast") }, leadingIcon = { Icon(Icons.Outlined.Podcasts, null) }, onClick = { menu = false; onClose(); nav.podcast(p.id) }) }
                val context = androidx.compose.ui.platform.LocalContext.current
                DropdownMenuItem({ Text("Share this moment") }, leadingIcon = { Icon(Icons.Outlined.Share, null) }, onClick = { menu = false; context.shareMoment(graph.session.serverUrl, episode.id, episode.title, st.podcast?.title, st.positionMs) })
                DropdownMenuItem({ Text("Episode details") }, leadingIcon = { Icon(Icons.Outlined.Info, null) }, onClick = { menu = false; onClose(); nav.episode(episode.id) })
                DropdownMenuItem({ Text("Full transcript") }, leadingIcon = { Icon(Icons.Outlined.Subject, null) }, onClick = { menu = false; onClose(); nav.transcript(episode.id) })
                DropdownMenuItem({ Text("Add to playlist…") }, leadingIcon = { Icon(Icons.Outlined.LibraryAdd, null) }, onClick = { menu = false; ui.playlistPickerEpisodeId = episode.id })
                item?.let { DropdownMenuItem({ Text("More actions…") }, leadingIcon = { Icon(Icons.Outlined.MoreHoriz, null) }, onClick = { menu = false; actions = true }) }
            }
            item?.let { EpisodeMenu(it, expanded = actions, onDismiss = { actions = false }) }
        }
    }
}

@Composable
private fun Transport(st: PlayerState) {
    val graph = LocalGraph.current
    val playing = st.isPlaying
    val corner by animateDpAsState(if (playing) 28.dp else 48.dp, spring(stiffness = Spring.StiffnessMediumLow), label = "play-corner")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { graph.player.back() }, Modifier.size(56.dp)) { SkipIcon(back = true, seconds = 15) }
        Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) {
            FilledIconButton(
                onClick = { graph.player.toggle() }, Modifier.size(88.dp), shape = RoundedCornerShape(corner),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
            ) {
                if (st.isBuffering && playing) CircularProgressIndicator(Modifier.size(40.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 3.dp)
                else Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (playing) "Pause" else "Play", Modifier.size(44.dp))
            }
        }
        IconButton(onClick = { graph.player.forward() }, Modifier.size(56.dp)) { SkipIcon(back = false, seconds = 30) }
        IconButton(onClick = { graph.player.next() }, Modifier.size(48.dp)) { Icon(Icons.Filled.SkipNext, "Next episode", Modifier.size(32.dp)) }
    }
}

@Composable
private fun SkipIcon(back: Boolean, seconds: Int) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.semantics { contentDescription = if (back) "Back $seconds seconds" else "Forward $seconds seconds" }) {
        Icon(if (back) Icons.Filled.Replay else Icons.Filled.Refresh, null, Modifier.size(38.dp))
        Text("$seconds", style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, fontSize = 10.sp))
    }
}

@Composable
private fun ActionRow(
    st: PlayerState, cast: CastState, transcriptOn: Boolean, hasChapters: Boolean, onCast: () -> Unit, onChapters: () -> Unit,
    onSpeed: () -> Unit, onSleep: () -> Unit, onBookmark: () -> Unit, onTranscript: () -> Unit, onQueue: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        AssistChip(
            onClick = onSpeed, label = { Text(Fmt.speed(st.speed), fontWeight = FontWeight.Bold) },
            modifier = Modifier.semantics { contentDescription = "Playback speed ${Fmt.speed(st.speed)}" },
            colors = AssistChipDefaults.assistChipColors(labelColor = if (st.speedIsOverride) scheme.tertiary else scheme.onSurface),
            border = AssistChipDefaults.assistChipBorder(true, borderColor = if (st.speedIsOverride) scheme.tertiary else scheme.outline),
        )
        SleepButton(st, onSleep)
        IconButton(onClick = onBookmark) { Icon(Icons.Outlined.BookmarkAdd, "Add bookmark", tint = scheme.tertiary) }
        IconButton(onClick = onTranscript) {
            Icon(if (transcriptOn) Icons.Filled.Subject else Icons.Outlined.Subject, if (transcriptOn) "Hide transcript" else "Show transcript", tint = if (transcriptOn) scheme.primary else scheme.onSurfaceVariant)
        }
        if (hasChapters) IconButton(onClick = onChapters) { Icon(Icons.AutoMirrored.Outlined.FormatListBulleted, "Chapters") }
        if (cast.supported) IconButton(onClick = onCast) {
            Icon(if (cast.connected != null) Icons.Filled.CastConnected else Icons.Outlined.Cast, if (cast.connected != null) "Casting to ${cast.connected?.name}. Choose a device" else "Cast to a device", tint = if (cast.connected != null) scheme.primary else scheme.onSurfaceVariant)
        }
        IconButton(onClick = onQueue) { Icon(Icons.Outlined.QueueMusic, "Up Next") }
    }
}

@Composable
private fun SleepButton(st: PlayerState, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val sleep = st.sleep
    if (sleep is SleepMode.Off) {
        IconButton(onClick = onClick) { Icon(Icons.Outlined.Bedtime, "Sleep timer", tint = scheme.onSurfaceVariant) }
        return
    }
    val label = when (sleep) {
        is SleepMode.Timer -> {
            val now by rememberNow()
            Fmt.sleepRemaining(maxOf(0L, sleep.endsAtMs - now))
        }
        else -> "End of ep."
    }
    AssistChip(
        onClick = onClick, label = { Text(label) }, leadingIcon = { Icon(Icons.Filled.Bedtime, null, Modifier.size(18.dp)) },
        colors = AssistChipDefaults.assistChipColors(labelColor = if (st.isFading) scheme.tertiary else scheme.primary, leadingIconContentColor = if (st.isFading) scheme.tertiary else scheme.primary),
        modifier = Modifier.semantics { contentDescription = "Sleep timer active, $label" },
    )
}

/** Wall-clock ticking once a second. */
@Composable
internal fun rememberNow(): State<Long> = produceState(System.currentTimeMillis()) {
    while (true) { value = System.currentTimeMillis(); delay(1000) }
}

// ---------------------------------------------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Scrubber(st: PlayerState, bookmarkMs: List<Long>, chapterMs: List<Long>, onSeek: (Long) -> Unit) {
    val duration = st.durationMs
    // While dragging (and briefly after release until the player catches up) we show our own value, not the 500 ms ticks.
    var drag by remember { mutableStateOf<Float?>(null) }
    var settling by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(st.positionMs, settling) { val t = settling; if (t != null && kotlin.math.abs(st.positionMs - t) < 2000) settling = null }
    LaunchedEffect(settling) { if (settling != null) { delay(1500); settling = null } }
    val frac = drag ?: settling?.let { if (duration > 0) it.toFloat() / duration else 0f } ?: st.progress
    val shownMs = if (duration > 0) (frac * duration).toLong() else st.positionMs
    val speed = if (st.speed > 0) st.speed else 1.0
    val remaining = ((duration - shownMs).coerceAtLeast(0) / speed).toLong()
    val scheme = MaterialTheme.colorScheme
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val colors = SliderDefaults.colors(thumbColor = scheme.primary, activeTrackColor = scheme.primary, inactiveTrackColor = scheme.outlineVariant)
    val ticks = remember(bookmarkMs, duration) { if (duration > 0) bookmarkMs.map { (it.toFloat() / duration).coerceIn(0f, 1f) } else emptyList() }
    val amber = scheme.tertiary
    val gaps = remember(chapterMs, duration) { if (duration > 0) chapterMs.filter { it in 1 until duration }.map { it.toFloat() / duration } else emptyList() }
    val gapColor = scheme.background

    Column(Modifier.fillMaxWidth()) {
        Slider(
            value = frac, enabled = duration > 0,
            onValueChange = { drag = it },
            onValueChangeFinished = { drag?.let { f -> val ms = (f * duration).toLong(); settling = ms; onSeek(ms) }; drag = null },
            interactionSource = interaction, colors = colors,
            modifier = Modifier.semantics { contentDescription = "Seek. ${Fmt.clock(shownMs)} of ${Fmt.clock(duration)}" },
            thumb = { SliderDefaults.Thumb(interaction, colors = colors) },
            track = { s ->
                Box(Modifier.fillMaxWidth().height(24.dp), contentAlignment = Alignment.Center) {
                    SliderDefaults.Track(s, colors = colors, drawStopIndicator = null, thumbTrackGapSize = 4.dp)
                    if (gaps.isNotEmpty()) androidx.compose.foundation.Canvas(Modifier.matchParentSize()) {
                        gaps.forEach { g -> drawRect(gapColor, androidx.compose.ui.geometry.Offset(g * size.width - 0.75.dp.toPx(), size.height / 2 - 2.dp.toPx()), androidx.compose.ui.geometry.Size(1.5.dp.toPx(), 4.dp.toPx())) }
                    }
                    if (ticks.isNotEmpty()) androidx.compose.foundation.Canvas(Modifier.matchParentSize()) {
                        ticks.forEach { t ->
                            val x = t * size.width
                            drawRoundRect(amber, androidx.compose.ui.geometry.Offset(x - 1.5.dp.toPx(), size.height / 2 - 9.dp.toPx()), androidx.compose.ui.geometry.Size(3.dp.toPx(), 18.dp.toPx()), androidx.compose.ui.geometry.CornerRadius(1.5.dp.toPx()))
                        }
                    }
                }
            },
        )
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(Fmt.clock(shownMs), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
            Text(
                if (duration > 0) "-${Fmt.clock(remaining)}" + if (st.speed != 1.0) "  at ${Fmt.speed(st.speed)}" else "" else "--:--",
                style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant,
            )
        }
    }
}

/** Chapter list for the playing episode: the current one is highlighted, tap to jump there. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChaptersSheet(chapters: List<Chapter>, positionMs: Long, onSeek: (Long) -> Unit, onDismiss: () -> Unit) {
    val current = chapters.indexOfLast { it.startMs <= positionMs }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Chapters", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            itemsIndexed(chapters, key = { i, c -> "$i-${c.startMs}" }) { i, c ->
                val on = i == current
                ListItem(
                    headlineContent = { Text(c.title, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) },
                    leadingContent = { Text(Fmt.clock(c.startMs), style = MaterialTheme.typography.labelLarge, color = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(56.dp)) },
                    colors = ListItemDefaults.colors(containerColor = if (on) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f) else androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.clickable { onSeek(c.startMs); onDismiss() },
                )
            }
        }
    }
}
