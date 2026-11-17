package app.homecast.playback

import android.app.Application
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import app.homecast.contract.CastDevice
import app.homecast.contract.CastState
import com.google.android.gms.cast.framework.CastContext
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Finds Cast devices and connects to one. The Cast framework starts a session when its route is selected, and the
 * [PlaybackEngine] moves playback onto it (see `attachCast`). Main thread only.
 */
internal class CastRoutes(private val app: Application) {
    val state = MutableStateFlow(CastState())
    private var router: MediaRouter? = null
    private var selector: MediaRouteSelector? = null
    private var discovering = false

    private val callback = object : MediaRouter.Callback() {
        override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
        override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
        override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
        override fun onRouteSelected(router: MediaRouter, route: MediaRouter.RouteInfo, reason: Int) = refresh()
        override fun onRouteUnselected(router: MediaRouter, route: MediaRouter.RouteInfo, reason: Int) = refresh()
    }

    /** Set up on first use. Without Google Play services (or a Cast framework that will start) casting is simply unavailable. */
    private fun ensure(): Boolean {
        if (router != null) return true
        return runCatching {
            val ctx = CastContext.getSharedInstance(app)
            selector = ctx.mergedSelector
            router = MediaRouter.getInstance(app)
        }.isSuccess && selector != null
    }

    /** Whether casting can work here, and (for the button) what is connected now. */
    fun init() {
        if (ensure()) refresh() else state.value = CastState()
    }

    fun startDiscovery() {
        if (!ensure() || discovering) return
        discovering = true
        router!!.addCallback(selector!!, callback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN)
        refresh()
    }

    fun stopDiscovery() {
        if (!discovering) return
        discovering = false
        router?.removeCallback(callback)
        refresh()
    }

    fun connect(deviceId: String) {
        val r = router ?: return
        r.routes.firstOrNull { it.id == deviceId }?.let { r.selectRoute(it) }
    }

    fun disconnect() {
        router?.unselect(MediaRouter.UNSELECT_REASON_STOPPED)
        router?.let { it.selectRoute(it.defaultRoute) }
    }

    private fun refresh() {
        val r = router ?: return
        val sel = selector ?: return
        val cast = r.routes.filter { !it.isDefault && !it.isBluetooth && it.matchesSelector(sel) && it.isEnabled }
        val selected = r.selectedRoute.takeIf { !it.isDefault && it.matchesSelector(sel) }
        state.value = CastState(
            supported = true,
            devices = cast.map { CastDevice(it.id, it.name) },
            connected = selected?.let { CastDevice(it.id, it.name) },
        )
    }
}
