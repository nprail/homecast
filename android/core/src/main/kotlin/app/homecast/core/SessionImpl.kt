package app.homecast.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.homecast.contract.*
import app.homecast.core.net.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** `podcasts.example.com` -> https://, trailing slashes stripped, `http://` kept as typed (LAN servers). Null if unusable. */
fun normalizeServerUrl(input: String): String? {
    var t = input.trim()
    if (t.isEmpty()) return null
    if (!t.contains("://")) t = "https://$t"
    t = t.trimEnd('/')
    val u = t.toHttpUrlOrNull() ?: return null
    return if (u.host.isNotEmpty()) t else null
}

/** SharedPreferences-backed [SecretStore]. */
class PrefsStore(private val prefs: () -> SharedPreferences) : SecretStore {
    override fun get(key: String): String? = prefs().getString(key, null)
    override fun set(key: String, value: String?) { prefs().edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
}

object SecretStores {
    /** Tokens in EncryptedSharedPreferences; if the keystore is broken (restored backups, OEM bugs) reset it, else fall back to private prefs. */
    fun encrypted(context: Context): SecretStore {
        val app = context.applicationContext
        val lazyPrefs = lazy {
            fun open() = EncryptedSharedPreferences.create(
                app, "homecast_secure", MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            try { open() } catch (e: Exception) {
                try { app.deleteSharedPreferences("homecast_secure"); open() } catch (e2: Exception) {
                    app.getSharedPreferences("homecast_secure_fallback", Context.MODE_PRIVATE)
                }
            }
        }
        return PrefsStore { lazyPrefs.value }
    }
    fun plain(context: Context, name: String = "homecast"): SecretStore =
        PrefsStore { context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE) }
}

class SessionImpl(
    private val api: ApiClient,
    private val plain: SecretStore,
    scope: CoroutineScope,
    /** Generic on purpose: no personal device names leave the phone. */
    private val deviceName: String = "Android",
) : Session {
    private val _state = MutableStateFlow<AuthState>(AuthState.Launching)
    override val state: StateFlow<AuthState> = _state

    init {
        api.baseUrl = plain.get("serverUrl") ?: ""
        api.onSessionLost = { signedOutLocally() }
        scope.launch { restore() }
    }

    override val serverUrl: String get() = plain.get("serverUrl") ?: ""

    /** Restoring works offline: the stored user plus credentials are enough, the local DB does the rest. */
    private fun restore() {
        val user = plain.get("user")?.let { runCatching { HcJson.decodeFromString<UserDto>(it) }.getOrNull() }
        _state.value = if (user != null && api.hasCredentials) AuthState.SignedIn(user.toUser()) else AuthState.SignedOut
    }

    override suspend fun signIn(server: String, username: String, password: String) {
        val url = urlOrThrow(server)
        api.baseUrl = url
        finish(url, api.login(username.trim(), password, deviceName))
    }

    override suspend fun register(server: String, username: String, password: String, inviteCode: String?, bootstrapToken: String?) {
        val url = urlOrThrow(server)
        api.baseUrl = url
        finish(url, api.register(username.trim(), password, inviteCode?.trim(), bootstrapToken?.trim(), deviceName))
    }

    override suspend fun signOut() {
        api.logout()
        signedOutLocally()
    }

    private fun urlOrThrow(server: String) = normalizeServerUrl(server)
        ?: throw ApiException(0, "Enter your server address, e.g. podcasts.example.com")

    private fun finish(url: String, auth: AuthResponse) {
        plain.set("serverUrl", url)
        plain.set("user", HcJson.encodeToString(UserDto.serializer(), auth.user))
        _state.value = AuthState.SignedIn(auth.user.toUser())
    }

    private fun signedOutLocally() {
        api.clear()
        plain.set("user", null)
        _state.value = AuthState.SignedOut
    }

    private fun UserDto.toUser() = User(id, username, role)
}
