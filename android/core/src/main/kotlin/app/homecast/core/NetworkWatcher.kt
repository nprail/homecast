package app.homecast.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/** Fires [onRegained] whenever the default network (re)appears. */
class NetworkWatcher(context: Context, private val onRegained: () -> Unit) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    @Volatile var isOnline: Boolean = true
        private set

    init {
        try {
            cm?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { isOnline = true; onRegained() }
                override fun onLost(network: Network) { isOnline = false }
            })
        } catch (e: Exception) { /* missing permission or restricted: the 60 s tick still covers us */ }
    }
}
