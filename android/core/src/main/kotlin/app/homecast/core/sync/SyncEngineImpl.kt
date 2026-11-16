package app.homecast.core.sync

import app.homecast.contract.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Drives [SyncCore] for the signed-in user. Triggers: start, connectivity regained, debounced [schedule], a 60 s tick
 * while running, and manual [sync]. Backoff after errors: 5 s doubling to 5 min; 15 s retry while offline.
 */
class SyncEngineImpl(private val scope: CoroutineScope) : SyncEngine {
    private val _state = MutableStateFlow(SyncState())
    override val state: StateFlow<SyncState> = _state
    @Volatile override var onMerged: (() -> Unit)? = null

    private val lock = Any()
    @Volatile private var core: SyncCore? = null
    private var running: Deferred<Unit>? = null
    private var again = false
    private var debounce: Job? = null
    private var ticker: Job? = null
    private var backoffSec = 0L
    private var lastSyncAt: Long? = null

    val isRunning: Boolean get() = core != null

    /** Begin syncing [core] (the signed-in user's). Safe to call again for the same user. */
    fun start(core: SyncCore) {
        synchronized(lock) {
            if (this.core === core) return
            stopLocked()
            this.core = core
            backoffSec = 0
            ticker = scope.launch { while (isActive) { delay(60_000); sync() } }
        }
        schedule(0)
    }

    fun stop() = synchronized(lock) { stopLocked(); _state.value = SyncState() }

    private fun stopLocked() {
        core = null
        debounce?.cancel(); debounce = null
        ticker?.cancel(); ticker = null
        running?.cancel(); running = null
        again = false
    }

    /** Connectivity regained. */
    fun onNetworkRegained() { if (core != null) schedule(0) }

    override fun schedule(delayMs: Long) {
        if (core == null) return
        synchronized(lock) {
            debounce?.cancel()
            debounce = scope.launch {
                if (delayMs > 0) delay(delayMs)
                sync()
            }
        }
    }

    override suspend fun sync() {
        val c = core ?: return
        var mine: Deferred<Unit>? = null
        val existing = synchronized(lock) {
            val r = running
            if (r != null) { again = true; r } else {
                mine = scope.async(start = CoroutineStart.LAZY) { runOnce(c) }
                running = mine
                null
            }
        }
        if (existing != null) { existing.join(); return }
        mine!!.join()
        synchronized(lock) {
            if (running === mine) running = null
            if (again) { again = false; if (core != null) schedule(300) }
        }
    }

    private suspend fun runOnce(c: SyncCore) {
        _state.value = _state.value.copy(status = SyncStatus.Syncing, message = null)
        try {
            c.run()
            backoffSec = 0
            lastSyncAt = System.currentTimeMillis()
            _state.value = SyncState(SyncStatus.Idle, lastSyncAt, null)
            onMerged?.invoke()
        } catch (e: CancellationException) {
            _state.value = _state.value.copy(status = SyncStatus.Idle)
            throw e
        } catch (e: Exception) {
            val offline = e is OfflineException
            _state.value = SyncState(if (offline) SyncStatus.Offline else SyncStatus.Error, lastSyncAt, e.message)
            backoffSec = minOf(if (backoffSec > 0) backoffSec * 2 else 5, 300)
            schedule((if (offline) 15L else backoffSec) * 1000)
        }
    }
}
