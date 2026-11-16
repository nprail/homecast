package app.homecast.android.ui.discover

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.ui.*
import app.homecast.android.ui.components.*
import app.homecast.contract.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private const val CACHE_KEY = "discover.cache"
private val sorts = listOf("subscribers" to "Most subscribers", "recent" to "Recently added", "az" to "A to Z")

private sealed interface Feed {
    data object Loading : Feed
    data class Items(val items: List<DiscoverItem>, val offline: Boolean) : Feed
    data class Failed(val message: String) : Feed
}

private fun encode(items: List<DiscoverItem>): String = JSONArray().also { a ->
    items.forEach { i ->
        a.put(JSONObject().put("id", i.id).put("title", i.title).put("author", i.author).put("imageUrl", i.imageUrl ?: JSONObject.NULL)
            .put("description", i.description).put("subscriberCount", i.subscriberCount).put("addedAt", i.addedAt))
    }
}.toString()

private fun decode(json: String): List<DiscoverItem> = runCatching {
    val a = JSONArray(json)
    (0 until a.length()).map { n ->
        val o = a.getJSONObject(n)
        DiscoverItem(o.getString("id"), o.getString("title"), o.optString("author"), if (o.isNull("imageUrl")) null else o.getString("imageUrl"), o.optString("description"), o.optInt("subscriberCount"), o.optLong("addedAt"))
    }
}.getOrDefault(emptyList())

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiscoverScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val lib = graph.library
    val scope = rememberCoroutineScope()
    val subscribed by remember(lib) { lib.subscribedPodcastIds() }.collectAsStateWithLifecycle(emptySet())
    var query by rememberSaveable { mutableStateOf("") }
    var sort by rememberSaveable { mutableStateOf("subscribers") }
    var sortMenu by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var feed by remember { mutableStateOf<Feed>(Feed.Loading) }
    var pending by remember { mutableStateOf(setOf<String>()) }

    LaunchedEffect(query, sort, reload) {
        val q = query.trim()
        if (q.isNotEmpty() && reload == 0) delay(350)
        if ((feed as? Feed.Items)?.items.isNullOrEmpty()) feed = Feed.Loading
        val isDefault = q.isEmpty() && sort == "subscribers"
        try {
            val items = graph.remote.discover(q.ifEmpty { null }, sort)
            feed = Feed.Items(items, offline = false)
            if (isDefault) runCatching { lib.kvSet(CACHE_KEY, encode(items)) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            val cached = if (isDefault && e is OfflineException) runCatching { lib.kvGet(CACHE_KEY) }.getOrNull()?.let(::decode).orEmpty() else emptyList()
            feed = if (cached.isNotEmpty()) Feed.Items(cached, offline = true)
            else Feed.Failed(if (e is OfflineException) "You're offline, or the server can't be reached." else e.message ?: "Couldn't load Discover.")
        }
    }

    fun subscribe(item: DiscoverItem) {
        if (item.id in pending) return
        pending = pending + item.id
        scope.launch {
            try {
                graph.remote.subscribe(item.id); lib.ensureSubscriptionLocal(item.id)
                launch { runCatching { graph.sync.sync() } }
                ui.toast("Subscribed to ${item.title}")
            } catch (e: CancellationException) { throw e } catch (e: OfflineException) { ui.toast("You need a connection to subscribe") } catch (e: Exception) { ui.toast(e.message ?: "Couldn't subscribe") }
            pending = pending - item.id
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = { Text("Discover") },
                actions = {
                    Box {
                        IconButton(onClick = { sortMenu = true }) { Icon(Icons.AutoMirrored.Filled.Sort, "Sort") }
                        DropdownMenu(sortMenu, { sortMenu = false }) {
                            sorts.forEach { (key, label) ->
                                DropdownMenuItem({ Text(label) }, onClick = { sort = key; sortMenu = false }, trailingIcon = { if (sort == key) Icon(Icons.Filled.Check, null) })
                            }
                        }
                    }
                },
            )
        },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize()) {
            OutlinedTextField(
                value = query, onValueChange = { query = it },
                placeholder = { Text("Search podcasts") },
                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear search") } },
                singleLine = true, shape = CircleShape,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { reload++ }),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            when (val f = feed) {
                Feed.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                is Feed.Failed -> EmptyState(Icons.Outlined.CloudOff, "Can't load Discover", f.message) { FilledTonalButton(onClick = { reload++ }) { Text("Try again") } }
                is Feed.Items -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(340.dp),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (f.offline) item(key = "offline", span = { GridItemSpan(maxLineSpan) }) {
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer)) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Icon(Icons.Outlined.CloudOff, null)
                                Text("Offline. Showing the last list you loaded.", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                TextButton(onClick = { reload++ }) { Text("Retry") }
                            }
                        }
                    }
                    if (f.items.isEmpty()) item(key = "none", span = { GridItemSpan(maxLineSpan) }) {
                        EmptyState(Icons.Outlined.Search, "No results", if (query.isBlank()) "Nothing has been shared yet." else "No podcasts match \"${query.trim()}\".")
                    }
                    items(f.items, key = { it.id }) { d -> DiscoverCard(d, d.id in subscribed, d.id in pending, onSubscribe = { subscribe(d) }, onOpen = { if (d.id in subscribed) nav.podcast(d.id) }) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiscoverCard(d: DiscoverItem, subscribed: Boolean, pending: Boolean, onSubscribe: () -> Unit, onOpen: () -> Unit) {
    ElevatedCard(onClick = { if (subscribed) onOpen() }, colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow, disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Artwork(d.imageUrl, Modifier.size(84.dp), cornerRadius = 14.dp, contentDescription = d.title)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(d.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (d.author.isNotBlank()) Text(d.author, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(Fmt.plural(d.subscriberCount, "subscriber"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                val desc = remember(d.description) { Fmt.plainText(d.description) }
                if (desc.isNotBlank()) Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(4.dp))
                if (subscribed) AssistChip(onClick = {}, enabled = false, label = { Text("Subscribed") }, leadingIcon = { Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) })
                else FilledTonalButton(onClick = onSubscribe, enabled = !pending, modifier = Modifier.heightIn(min = 48.dp)) {
                    if (pending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else { Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Subscribe") }
                }
            }
        }
    }
}
