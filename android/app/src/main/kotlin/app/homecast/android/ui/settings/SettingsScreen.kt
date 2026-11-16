package app.homecast.android.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.homecast.android.BuildConfig
import app.homecast.android.ui.AppNav
import app.homecast.android.ui.LocalAppUi
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.Fmt
import app.homecast.android.ui.components.SectionLabel
import app.homecast.contract.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

private val CAPS = listOf(0 to "Unlimited", 1024 to "1 GB", 2048 to "2 GB", 5120 to "5 GB", 10240 to "10 GB")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: AppNav) {
    val graph = LocalGraph.current
    val ui = LocalAppUi.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val auth by graph.session.state.collectAsStateWithLifecycle()
    val user = (auth as? AuthState.SignedIn)?.user
    val sync by graph.sync.state.collectAsStateWithLifecycle()
    val settings by remember { graph.library.settings() }.collectAsStateWithLifecycle(UserSettings())
    val device by graph.downloads.deviceSettings.collectAsStateWithLifecycle()
    val usedBytes by remember { graph.library.downloadedBytes() }.collectAsStateWithLifecycle(0L)
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val server = graph.session.serverUrl

    var changePw by remember { mutableStateOf(false) }
    var signOut by remember { mutableStateOf(false) }
    var capMenu by remember { mutableStateOf(false) }
    var busyExport by remember { mutableStateOf(false) }
    var pendingExport by remember { mutableStateOf<String?>(null) }

    fun toast(msg: String) { scope.launch { ui.toast(msg) } }
    fun failure(e: Throwable) = toast(e.message ?: "Something went wrong.")

    val importPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch {
            try {
                val text = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: error("Couldn't read that file.") }
                val r = graph.remote.importOpml(text)
                graph.sync.sync()
                ui.toast(r.summary)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { failure(e) }
        }
    }
    // Exports are fetched first, then the user picks where to save them (no storage permission or FileProvider needed).
    val exportOpml = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/xml")) { uri: Uri? ->
        val data = pendingExport; pendingExport = null
        if (uri != null && data != null) scope.launch {
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(data.toByteArray()) } }; ui.toast("Saved") } catch (e: Exception) { failure(e) }
        }
    }
    val exportJson = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        val data = pendingExport; pendingExport = null
        if (uri != null && data != null) scope.launch {
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(data.toByteArray()) } }; ui.toast("Saved") } catch (e: Exception) { failure(e) }
        }
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { LargeTopAppBar(title = { Text("Settings") }, scrollBehavior = scroll) },
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            // ---- Account
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), shape = MaterialTheme.shapes.extraLarge) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Box(Modifier.size(52.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                                Text((user?.username?.firstOrNull() ?: '?').uppercase(), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                            }
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(user?.username ?: "Signed in", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                    if (user?.isAdmin == true) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.tertiary) {
                                        Text("ADMIN", Modifier.padding(horizontal = 8.dp, vertical = 3.dp), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp), color = MaterialTheme.colorScheme.onTertiary)
                                    }
                                }
                                Text(server, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (user?.isAdmin == true) TextButton(onClick = {
                            val base = if ("://" in server) server else "https://$server"
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(base.trimEnd('/') + "/admin"))) }
                        }) { Icon(Icons.Outlined.AdminPanelSettings, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Open admin dashboard") }
                        HorizontalDivider()
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                when (sync.status) { SyncStatus.Offline -> Icons.Outlined.CloudOff; SyncStatus.Error -> Icons.Outlined.ErrorOutline; else -> Icons.Outlined.CloudDone }, null,
                                tint = if (sync.status == SyncStatus.Error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                            )
                            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                                Text(
                                    when (sync.status) { SyncStatus.Syncing -> "Syncing…"; SyncStatus.Offline -> "Offline"; SyncStatus.Error -> "Sync problem"; SyncStatus.Idle -> "Up to date" },
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                                val detail = sync.message ?: sync.lastSyncAt?.let { "Last synced ${Fmt.released(it)}" }
                                if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            FilledTonalButton(onClick = { scope.launch { runCatching { graph.sync.sync() } } }, enabled = sync.status != SyncStatus.Syncing) {
                                if (sync.status == SyncStatus.Syncing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("Sync now")
                            }
                        }
                    }
                }
            }
            // ---- Playback
            item {
                Group("Playback", footer = "Changing speed in the player for one podcast overrides this default for that podcast.") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Default speed", style = MaterialTheme.typography.bodyLarge)
                            Text("Applies to podcasts without their own speed", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        fun set(v: Double) = scope.launch(NonCancellable) { graph.library.setDefaultSpeed((v * 10).roundToInt() / 10.0); graph.player.refreshSpeed() }
                        FilledTonalIconButton(onClick = { set((settings.defaultSpeed - 0.1).coerceAtLeast(0.5)) }, enabled = settings.defaultSpeed > 0.5) { Icon(Icons.Filled.Remove, "Slower") }
                        Text(Fmt.speed(settings.defaultSpeed), Modifier.widthIn(min = 56.dp), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                        FilledTonalIconButton(onClick = { set((settings.defaultSpeed + 0.1).coerceAtMost(3.0)) }, enabled = settings.defaultSpeed < 3.0) { Icon(Icons.Filled.Add, "Faster") }
                    }
                    if (settings.podcastSpeeds.isNotEmpty()) ListItem(
                        leadingContent = { Icon(Icons.Outlined.Speed, null, tint = MaterialTheme.colorScheme.tertiary) },
                        headlineContent = { Text("${Fmt.plural(settings.podcastSpeeds.size, "podcast")} with their own speed") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
            }
            // ---- This device
            item {
                Group("This device", footer = "Oldest played episodes are removed first when the cap is reached.") {
                    ListItem(
                        headlineContent = { Text("Download on Wi-Fi only") },
                        trailingContent = { Switch(device.wifiOnly, { graph.downloads.updateDeviceSettings(device.copy(wifiOnly = it)) }) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                    Box {
                        ListItem(
                            headlineContent = { Text("Storage cap") },
                            supportingContent = { Text("${Fmt.bytes(usedBytes)} used") },
                            trailingContent = { Text((CAPS.firstOrNull { it.first == device.storageCapMb } ?: (device.storageCapMb to "${device.storageCapMb} MB")).second, color = MaterialTheme.colorScheme.primary) },
                            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            modifier = Modifier.clickable { capMenu = true },
                        )
                        DropdownMenu(capMenu, { capMenu = false }, offset = androidx.compose.ui.unit.DpOffset(16.dp, 0.dp)) {
                            CAPS.forEach { (mb, label) ->
                                DropdownMenuItem({ Text(label) }, trailingIcon = { if (mb == device.storageCapMb) Icon(Icons.Filled.Check, null) }, onClick = {
                                    capMenu = false
                                    graph.downloads.updateDeviceSettings(device.copy(storageCapMb = mb)); graph.downloads.enforceCap()
                                })
                            }
                        }
                    }
                }
            }
            // ---- Library
            item {
                Group("Library") {
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.AddCircleOutline, null) }, headlineContent = { Text("Add podcast") }, supportingContent = { Text("By feed URL, including private feeds") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { ui.showAddPodcast = true },
                    )
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.FileUpload, null) }, headlineContent = { Text("Import OPML") }, supportingContent = { Text("Subscribe to everything in an OPML file") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { importPicker.launch(arrayOf("*/*")) },
                    )
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.FileDownload, null) }, headlineContent = { Text("Export OPML") }, supportingContent = { Text("Your subscriptions as a portable file") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.clickable(enabled = !busyExport) {
                            busyExport = true
                            scope.launch {
                                try { pendingExport = graph.remote.exportOpml(); exportOpml.launch("homecast-subscriptions.opml") } catch (e: CancellationException) { throw e } catch (e: Exception) { failure(e) }
                                busyExport = false
                            }
                        },
                    )
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.Inventory2, null) }, headlineContent = { Text("Export all my data") }, supportingContent = { Text("Subscriptions, progress, bookmarks and playlists as JSON") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.clickable(enabled = !busyExport) {
                            busyExport = true
                            scope.launch {
                                try { pendingExport = graph.remote.exportData(); exportJson.launch("homecast-data.json") } catch (e: CancellationException) { throw e } catch (e: Exception) { failure(e) }
                                busyExport = false
                            }
                        },
                    )
                }
            }
            // ---- Devices
            item { DevicesSection(onError = ::failure) }
            // ---- Security / sign out
            item {
                Group("Account") {
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.Password, null) }, headlineContent = { Text("Change password") },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { changePw = true },
                    )
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.Logout, null, tint = MaterialTheme.colorScheme.error) }, headlineContent = { Text("Sign out", color = MaterialTheme.colorScheme.error) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { signOut = true },
                    )
                }
            }
            item {
                Text("Homecast ${BuildConfig.VERSION_NAME}", Modifier.fillMaxWidth().padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
    }

    if (changePw) ChangePasswordDialog(onDismiss = { changePw = false }, onDone = { toast("Password changed") })
    if (signOut) AlertDialog(
        onDismissRequest = { signOut = false }, title = { Text("Sign out?") },
        text = { Text("Downloaded episodes stay on this device. You can sign back in any time.") },
        confirmButton = { TextButton(onClick = { signOut = false; scope.launch(NonCancellable) { graph.session.signOut() } }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { signOut = false }) { Text("Cancel") } },
    )
}

@Composable
private fun Group(title: String, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(title, Modifier.padding(horizontal = 12.dp))
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), shape = MaterialTheme.shapes.extraLarge) { Column(Modifier.padding(vertical = 4.dp), content = content) }
        if (footer != null) Text(footer, Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DevicesSection(onError: (Throwable) -> Unit) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var sessions by remember { mutableStateOf<List<SessionInfo>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        try { sessions = graph.remote.sessions(); failed = false } catch (e: CancellationException) { throw e } catch (e: Exception) { failed = true }
    }
    Group("Signed-in devices", footer = "Signing out a device ends its session the next time it connects.") {
        val list = sessions
        when {
            list == null && !failed -> Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
            list == null -> ListItem(
                leadingContent = { Icon(Icons.Outlined.CloudOff, null) }, headlineContent = { Text("Couldn't load devices") }, supportingContent = { Text("Tap to retry") },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { reload++ },
            )
            else -> {
                list.forEach { s ->
                    ListItem(
                        leadingContent = { Icon(Icons.Outlined.Smartphone, null, tint = if (s.current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
                        headlineContent = { Text(s.deviceName.ifBlank { "Unknown device" } + if (s.current) " (this device)" else "") },
                        supportingContent = { Text("Last used ${Fmt.released(s.lastUsedAt)}") },
                        trailingContent = {
                            if (!s.current) IconButton(onClick = { scope.launch { try { graph.remote.revokeSession(s.id); reload++ } catch (e: CancellationException) { throw e } catch (e: Exception) { onError(e) } } }) {
                                Icon(Icons.Outlined.Logout, "Sign out ${s.deviceName}")
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
                if (list.count { !it.current } > 0) TextButton(onClick = {
                    scope.launch {
                        try { list.filter { !it.current }.forEach { graph.remote.revokeSession(it.id) } } catch (e: CancellationException) { throw e } catch (e: Exception) { onError(e) }
                        reload++
                    }
                }, Modifier.padding(horizontal = 8.dp)) { Text("Sign out of all other devices") }
            }
        }
    }
}

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit, onDone: () -> Unit) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val valid = current.isNotEmpty() && next.length >= 10 && next == confirm
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(current, { current = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(next, { next = it }, label = { Text("New password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("At least 10 characters") }, isError = next.isNotEmpty() && next.length < 10)
                OutlinedTextField(confirm, { confirm = it }, label = { Text("Confirm new password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
                    isError = confirm.isNotEmpty() && confirm != next)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(enabled = valid && !busy, onClick = {
                busy = true; error = null
                scope.launch {
                    try { graph.remote.changePassword(current, next); onDone(); onDismiss() }
                    catch (e: CancellationException) { throw e }
                    catch (e: ApiException) { error = e.message }
                    catch (e: OfflineException) { error = e.message }
                    catch (e: Exception) { error = e.message ?: "Something went wrong." }
                    busy = false
                }
            }) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Change") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}
