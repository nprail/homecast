package app.homecast.android.ui.auth

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.homecast.android.ui.LocalGraph
import app.homecast.android.ui.components.HomecastLogo
import app.homecast.contract.ApiException
import app.homecast.contract.OfflineException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Sign in / join against a self-hosted server (spec §3.9: invite-only, bootstrap token for the first admin). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthScreen() {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    var join by rememberSaveable { mutableStateOf(false) }
    var server by rememberSaveable { mutableStateOf(graph.session.serverUrl) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var invite by rememberSaveable { mutableStateOf("") }
    var bootstrap by rememberSaveable { mutableStateOf("") }
    var newServer by rememberSaveable { mutableStateOf(false) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val extra = if (join) (if (newServer) bootstrap else invite) else "x"
    val canSubmit = server.isNotBlank() && username.isNotBlank() && password.isNotEmpty() && extra.isNotBlank() && !busy

    fun submit() {
        if (!canSubmit) return
        focus.clearFocus()
        busy = true; error = null
        scope.launch {
            try {
                if (!join) graph.session.signIn(server.trim(), username.trim(), password)
                else graph.session.register(
                    server.trim(), username.trim(), password,
                    inviteCode = if (newServer) null else invite.trim(),
                    bootstrapToken = if (newServer) bootstrap.trim() else null,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                error = e.message
            } catch (e: OfflineException) {
                error = e.message
            } catch (e: Exception) {
                error = e.message ?: "Something went wrong."
            } finally {
                busy = false
            }
        }
    }

    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f), MaterialTheme.colorScheme.background), endY = 1400f),
        ),
    ) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).safeDrawingPadding().padding(horizontal = 24.dp).widthIn(max = 480.dp).align(Alignment.TopCenter),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(32.dp))
            Surface(shape = RoundedCornerShape(32.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, tonalElevation = 2.dp) {
                HomecastLogo(76.dp, Modifier.padding(22.dp), wave = MaterialTheme.colorScheme.primary, floor = MaterialTheme.colorScheme.tertiary)
            }
            Spacer(Modifier.height(16.dp))
            Text("Homecast", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onBackground)
            Spacer(Modifier.height(4.dp))
            Text("Your podcasts, on your own server.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            Spacer(Modifier.height(28.dp))

            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                SegmentedButton(!join, { join = false; error = null }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("Sign in") }
                SegmentedButton(join, { join = true; error = null }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Join") }
            }
            Spacer(Modifier.height(16.dp))

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer), shape = MaterialTheme.shapes.extraLarge) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AuthField(
                        server, { server = it }, "Server", Icons.Filled.Dns, placeholder = "podcasts.example.com",
                        keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, onNext = { focus.moveFocus(FocusDirection.Down) },
                    )
                    AuthField(
                        username, { username = it }, "Username", Icons.Filled.Person,
                        keyboardType = KeyboardType.Text, imeAction = ImeAction.Next, onNext = { focus.moveFocus(FocusDirection.Down) },
                        contentType = if (join) ContentType.NewUsername else ContentType.Username,
                    )
                    AuthField(
                        password, { password = it }, "Password", Icons.Filled.Lock,
                        keyboardType = KeyboardType.Password,
                        imeAction = if (join) ImeAction.Next else ImeAction.Go,
                        onNext = { if (join) focus.moveFocus(FocusDirection.Down) else submit() },
                        contentType = if (join) ContentType.NewPassword else ContentType.Password,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        trailing = {
                            IconButton(onClick = { showPassword = !showPassword }) {
                                Icon(if (showPassword) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, if (showPassword) "Hide password" else "Show password")
                            }
                        },
                    )
                    AnimatedVisibility(join) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            if (newServer) AuthField(
                                bootstrap, { bootstrap = it }, "Bootstrap token", Icons.Filled.Key, placeholder = "From the server log",
                                imeAction = ImeAction.Go, onNext = { submit() },
                            ) else AuthField(
                                invite, { invite = it }, "Invite code", Icons.Filled.ConfirmationNumber, placeholder = "inv_…",
                                imeAction = ImeAction.Go, onNext = { submit() },
                            )
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text("I'm setting up a new server", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Switch(newServer, { newServer = it })
                            }
                        }
                    }
                }
            }

            AnimatedVisibility(error != null) {
                Text(error.orEmpty(), Modifier.padding(top = 16.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.height(20.dp))
            Button(onClick = ::submit, enabled = canSubmit || busy, modifier = Modifier.fillMaxWidth().height(56.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text(if (join) "Create account" else "Sign in", style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(16.dp))
            Text(
                if (join) "Registration is invite-only. Ask your server's admin for a code." else "Passwords are at least 10 characters. Use https when your server is on the internet.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun AuthField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    placeholder: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    onNext: () -> Unit,
    contentType: ContentType? = null,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null,
) {
    OutlinedTextField(
        value = value, onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().let { if (contentType != null) it.semantics { this.contentType = contentType } else it },
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        leadingIcon = { Icon(icon, null) },
        trailingIcon = trailing,
        singleLine = true,
        visualTransformation = visualTransformation,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = KeyboardActions(onNext = { onNext() }, onGo = { onNext() }),
        shape = MaterialTheme.shapes.medium,
    )
}
