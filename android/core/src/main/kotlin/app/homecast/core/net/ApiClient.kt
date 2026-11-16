package app.homecast.core.net

import app.homecast.contract.ApiException
import app.homecast.contract.OfflineException
import app.homecast.core.HcJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Small key/value store for secrets. Production: EncryptedSharedPreferences. Tests: in memory. */
interface SecretStore {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

class MemorySecretStore : SecretStore {
    private val m = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun get(key: String): String? = m[key]
    override fun set(key: String, value: String?) { if (value == null) m.remove(key) else m[key] = value }
}

@Serializable data class UserDto(val id: String, val username: String, val role: String)
@Serializable data class AuthResponse(val user: UserDto, val accessToken: String, val accessTokenExpiresAt: Double, val refreshToken: String? = null)

data class HttpResult(val status: Int, val body: String) { val ok get() = status in 200..299 }

/**
 * Talks to the Homecast server (`/api/v1`). Holds the access token in memory (and in the secret store), refreshes it when
 * it is about to expire or on 401 using the rotating refresh token (spec §7), and distinguishes "offline" from real errors.
 */
class ApiClient(
    private val secrets: SecretStore,
    initialBaseUrl: String = "",
    private val http: OkHttpClient = defaultClient(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Volatile var baseUrl: String = initialBaseUrl
    /** Invoked when the server says the session is gone (refresh rejected). */
    @Volatile var onSessionLost: (() -> Unit)? = null

    private val accessToken: String? get() = secrets.get("accessToken")
    private val accessExpiry: Long get() = secrets.get("accessExpiry")?.toLongOrNull() ?: 0
    private val refreshLock = Mutex()

    val hasCredentials: Boolean get() = accessToken != null || secrets.get("refreshToken") != null

    fun store(auth: AuthResponse) {
        secrets.set("accessToken", auth.accessToken)
        secrets.set("accessExpiry", auth.accessTokenExpiresAt.toLong().toString())
        auth.refreshToken?.let { secrets.set("refreshToken", it) }
    }

    fun clear() {
        listOf("accessToken", "accessExpiry", "refreshToken").forEach { secrets.set(it, null) }
    }

    // ---- auth

    suspend fun login(username: String, password: String, deviceName: String): AuthResponse =
        authenticate("/auth/login", buildJsonObject {
            put("username", username); put("password", password); put("deviceName", deviceName); put("client", "native")
        })

    suspend fun register(username: String, password: String, inviteCode: String?, bootstrapToken: String?, deviceName: String): AuthResponse =
        authenticate("/auth/register", buildJsonObject {
            put("username", username); put("password", password); put("deviceName", deviceName); put("client", "native")
            if (!inviteCode.isNullOrEmpty()) put("inviteCode", inviteCode)
            if (!bootstrapToken.isNullOrEmpty()) put("bootstrapToken", bootstrapToken)
        })

    private suspend fun authenticate(path: String, body: JsonObject): AuthResponse {
        val r = raw("POST", path, body.toString(), "application/json", auth = false, retry = false)
        if (!r.ok) throw errorOf(r)
        val auth = decode<AuthResponse>(r.body)
        store(auth)
        return auth
    }

    suspend fun logout() {
        val rt = secrets.get("refreshToken")
        try {
            val body = buildJsonObject { if (rt != null) put("refreshToken", rt) }.toString()
            raw("POST", "/auth/logout", body, "application/json", auth = true, retry = false)
        } catch (_: Exception) { /* best effort */ }
        clear()
    }

    /** Exchanges the refresh token. False if the server says the session is gone; true when rotated or when offline (keep the session, retry later). */
    suspend fun refresh(): Boolean {
        val before = secrets.get("refreshToken")
        return refreshLock.withLock {
            val rt = secrets.get("refreshToken")
            if (rt != before) return@withLock true // another caller already rotated it
            if (rt == null) return@withLock false
            try {
                val r = raw("POST", "/auth/refresh", buildJsonObject { put("refreshToken", rt) }.toString(), "application/json", auth = false, retry = false)
                when {
                    r.ok -> runCatching { decode<AuthResponse>(r.body) }.getOrNull()?.let { store(it); true } ?: true
                    r.status == 400 || r.status == 401 || r.status == 403 -> false
                    else -> true // transient server trouble: keep the session
                }
            } catch (e: OfflineException) { true }
        }
    }

    // ---- requests

    /** An absolute URL on the configured server for a server-relative path such as `/api/v1/media/...`. */
    fun resolve(path: String): String = baseUrl.trimEnd('/') + path

    suspend fun get(path: String): HttpResult = ok(raw("GET", path, null, null, auth = true, retry = true))
    suspend fun postJson(path: String, body: JsonElement? = null): HttpResult =
        ok(raw("POST", path, body?.toString() ?: "{}", "application/json", auth = true, retry = true))
    suspend fun postText(path: String, text: String, contentType: String): HttpResult =
        ok(raw("POST", path, text, contentType, auth = true, retry = true))
    suspend fun delete(path: String): HttpResult = ok(raw("DELETE", path, null, null, auth = true, retry = true))

    /** Like [postJson] but returns the result without throwing on non-2xx (callers inspect the status). */
    suspend fun postJsonRaw(path: String, body: String): HttpResult = raw("POST", path, body, "application/json", auth = true, retry = true)
    suspend fun getRaw(path: String): HttpResult = raw("GET", path, null, null, auth = true, retry = true)

    private fun ok(r: HttpResult): HttpResult = if (r.ok) r else throw errorOf(r)

    fun errorOf(r: HttpResult): ApiException {
        val e = runCatching { HcJson.parseToJsonElement(r.body).jsonObject["error"]?.jsonObject }.getOrNull()
        val message = e?.get("message")?.jsonPrimitive?.contentOrNull ?: "Request failed (${r.status})"
        return ApiException(r.status, message, e?.get("code")?.jsonPrimitive?.contentOrNull)
    }

    suspend fun raw(method: String, path: String, body: String?, contentType: String?, auth: Boolean, retry: Boolean): HttpResult {
        if (auth && retry && (accessToken == null || clock() > accessExpiry - 60_000) && secrets.get("refreshToken") != null) {
            if (!refresh()) { sessionLost(); throw ApiException(401, "Your session has ended. Sign in again.", "unauthorized") }
        }
        val r = execute(method, path, body, contentType, if (auth) accessToken else null)
        if (r.status == 401 && auth && retry) {
            if (refresh()) return raw(method, path, body, contentType, auth, retry = false)
            sessionLost()
        }
        return r
    }

    private fun sessionLost() { clear(); onSessionLost?.invoke() }

    private suspend fun execute(method: String, path: String, body: String?, contentType: String?, token: String?): HttpResult {
        val base = baseUrl.trimEnd('/')
        if (base.isEmpty()) throw ApiException(0, "Enter your server address, e.g. podcasts.example.com")
        val rb = Request.Builder().url("$base/api/v1$path")
        val media = contentType?.toMediaTypeOrNull()
        val reqBody = when {
            body != null -> body.toRequestBody(media)
            method == "POST" || method == "PUT" || method == "PATCH" -> "".toRequestBody(null)
            else -> null
        }
        rb.method(method, reqBody)
        if (token != null) rb.header("authorization", "Bearer $token")
        val call = try { http.newCall(rb.build()) } catch (e: IllegalArgumentException) { throw ApiException(0, "That server address doesn't look right.") }
        return try {
            call.await().use { HttpResult(it.code, it.body.string()) }
        } catch (e: CancellationException) { throw e }
        catch (e: IOException) { throw OfflineException() }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(40, TimeUnit.SECONDS).writeTimeout(40, TimeUnit.SECONDS).build()

        inline fun <reified T> decode(s: String): T = try { HcJson.decodeFromString<T>(s) } catch (e: Exception) {
            throw ApiException(0, "Unexpected response from the server.", "decode")
        }
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (!cont.isCancelled) cont.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) { cont.resume(response) }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
