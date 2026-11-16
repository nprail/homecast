package app.homecast.android.ui.bookmarks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.BookmarkTarget
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.Artwork
import app.homecast.android.ui.components.EmptyState
import app.homecast.android.ui.components.Fmt
import app.homecast.contract.BookmarkItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookmarksScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val items by remember { graph.library.bookmarks() }.collectAsStateWithLifecycle(null)
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    fun open(b: BookmarkItem) {
        val id = b.bookmark.episodeId
        graph.player.play(id)
        graph.player.seekTo(b.bookmark.positionMs)
        ui.showPlayer = true
        // The first seek can land before the media item is prepared; repeat once it has had time to load.
        scope.launch { delay(600); if (graph.player.state.value.episode?.id == id) graph.player.seekTo(b.bookmark.positionMs) }
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            LargeTopAppBar(
                title = { Text("Bookmarks") },
                navigationIcon = { IconButton(onClick = nav::back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                scrollBehavior = scroll,
            )
        },
    ) { pad ->
        val list = items
        when {
            list == null -> Box(Modifier.padding(pad).fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            list.isEmpty() -> Box(Modifier.padding(pad).fillMaxSize(), Alignment.Center) {
                EmptyState(Icons.Outlined.BookmarkBorder, "No bookmarks yet", "Tap the bookmark button in the player to save a moment with a note.")
            }
            else -> LazyColumn(Modifier.padding(pad).fillMaxSize()) {
                items(list, key = { it.bookmark.id }) { b ->
                    val dismiss = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
                        if (v == SwipeToDismissBoxValue.EndToStart) { scope.launch { graph.library.deleteBookmark(b.bookmark.id); ui.toast("Bookmark deleted") }; true } else false
                    })
                    SwipeToDismissBox(
                        dismiss, enableDismissFromStartToEnd = false,
                        backgroundContent = {
                            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer).padding(horizontal = 24.dp), contentAlignment = Alignment.CenterEnd) {
                                Icon(Icons.Outlined.Delete, "Delete bookmark", tint = MaterialTheme.colorScheme.onErrorContainer)
                            }
                        },
                        modifier = Modifier.animateItem(),
                    ) {
                        BookmarkRow(b, onClick = { open(b) }, onEdit = { ui.bookmarkTarget = BookmarkTarget(b.bookmark.episodeId, b.bookmark.positionMs, b.bookmark.id) })
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

@Composable
private fun BookmarkRow(b: BookmarkItem, onClick: () -> Unit, onEdit: () -> Unit) {
    val bm = b.bookmark
    Surface(color = MaterialTheme.colorScheme.background) {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Play from bookmark", onClick = onClick).padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = 4.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Artwork(b.podcast?.imageUrl, Modifier.size(56.dp), cornerRadius = 12.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Filled.Bookmark, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.tertiary)
                    Text(Fmt.clock(bm.positionMs), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.tertiary)
                }
                Text(bm.title?.takeIf { it.isNotBlank() } ?: b.episode?.title ?: "Bookmark", style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(b.episode?.title?.takeIf { bm.title?.isNotBlank() == true }, b.podcast?.title).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                bm.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                b.transcriptPreview?.takeIf { it.isNotBlank() }?.let {
                    Text("“$it”", style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            IconButton(onClick = onEdit) { Icon(Icons.Outlined.Edit, "Edit bookmark") }
        }
    }
}

/** Add or edit a bookmark: optional title, note, position and a transcript preview of that moment. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookmarkSheet(target: BookmarkTarget, onDismiss: () -> Unit) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val scope = rememberCoroutineScope()
    val editing = target.existingBookmarkId != null
    val existing by remember(target) { graph.library.bookmarksForEpisode(target.episodeId) }.collectAsStateWithLifecycle(emptyList())
    val episode by remember(target) { graph.library.episode(target.episodeId) }.collectAsStateWithLifecycle(null)
    var title by rememberSaveable(target) { mutableStateOf("") }
    var note by rememberSaveable(target) { mutableStateOf("") }
    var loaded by rememberSaveable(target) { mutableStateOf(!editing) }
    LaunchedEffect(existing) {
        if (!loaded) existing.firstOrNull { it.id == target.existingBookmarkId }?.let { title = it.title.orEmpty(); note = it.note.orEmpty(); loaded = true }
    }
    val preview by produceState<String?>(null, target) { value = runCatching { graph.library.transcriptPreview(target.episodeId, target.positionMs) }.getOrNull() }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Filled.Bookmark, null, tint = MaterialTheme.colorScheme.tertiary)
                Column(Modifier.weight(1f)) {
                    Text(if (editing) "Edit bookmark" else "Add bookmark", style = MaterialTheme.typography.titleLarge)
                    episode?.let { Text(it.episode.title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                AssistChip(onClick = {}, label = { Text(Fmt.clock(target.positionMs)) }, colors = AssistChipDefaults.assistChipColors(labelColor = MaterialTheme.colorScheme.tertiary), leadingIcon = { Icon(Icons.Outlined.Schedule, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.tertiary) })
            }
            preview?.takeIf { it.isNotBlank() }?.let {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    Text("“$it”", Modifier.fillMaxWidth().padding(12.dp), style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Title (optional)") }, singleLine = true)
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text("Note") }, minLines = 3, maxLines = 6)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                if (editing) TextButton(onClick = {
                    scope.launch(kotlinx.coroutines.NonCancellable) { graph.library.deleteBookmark(target.existingBookmarkId!!); ui.toast("Bookmark deleted") }; onDismiss()
                }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Delete") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Button(enabled = loaded, onClick = {
                    val t = title.trim().ifEmpty { null }; val n = note.trim().ifEmpty { null }
                    scope.launch(kotlinx.coroutines.NonCancellable) {
                        if (editing) graph.library.updateBookmark(target.existingBookmarkId!!, t, n)
                        else graph.library.addBookmark(target.episodeId, target.positionMs, t, n)
                        ui.toast(if (editing) "Bookmark updated" else "Bookmarked ${Fmt.clock(target.positionMs)}")
                    }
                    onDismiss()
                }) { Text(if (editing) "Save" else "Add") }
            }
        }
    }
}
