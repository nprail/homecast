package app.homecast.core

import android.app.Application
import app.homecast.contract.*
import app.homecast.core.net.ApiClient
import app.homecast.core.sync.SyncEngineImpl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * Entry point of the data layer. One instance per process; `library` delegates to the signed-in user's Room database.
 * The sync engine starts itself when the session becomes signed in and stops on sign-out.
 */
class CoreComponents(app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val api = ApiClient(SecretStores.encrypted(app))
    private val sessionImpl = SessionImpl(api, SecretStores.plain(app), scope)
    private val engine = SyncEngineImpl(scope)
    private val workspaces = Workspaces.forContext(app, { engine }) { body ->
        val r = api.postJsonRaw("/sync", body)
        if (!r.ok) throw api.errorOf(r)
        r.body
    }
    private val libraryFacade = LibraryFacade(sessionImpl, workspaces)

    val session: Session get() = sessionImpl
    val library: Library get() = libraryFacade
    val remote: Remote = RemoteImpl(api, libraryFacade)
    val sync: SyncEngine get() = engine

    init {
        NetworkWatcher(app) { engine.onNetworkRegained() }
        scope.launch {
            sessionImpl.state.collect { st ->
                when (st) {
                    is AuthState.SignedIn -> engine.start(workspaces.get(st.user.id).core)
                    else -> engine.stop()
                }
            }
        }
    }
}
