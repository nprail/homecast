package app.homecast.core

import android.content.Context
import app.homecast.contract.SyncEngine
import app.homecast.core.db.AppDb
import app.homecast.core.sync.SyncCore

/** Everything that exists for one signed-in user: their database, library and sync core. */
class Workspace(val userId: String, val db: AppDb, val library: LibraryImpl, val core: SyncCore)

/** One Room database per user (`homecast-<userId>.db`), opened lazily and kept for the process lifetime. */
class Workspaces(
    private val openDb: (String) -> AppDb,
    private val engine: () -> SyncEngine?,
    private val transport: suspend (String) -> String,
) {
    private val map = HashMap<String, Workspace>()

    @Synchronized fun get(userId: String): Workspace = map.getOrPut(userId) {
        val db = openDb(userId)
        Workspace(userId, db, LibraryImpl(db, userId, engine), SyncCore(db, transport))
    }

    companion object {
        fun forContext(context: Context, engine: () -> SyncEngine?, transport: suspend (String) -> String) =
            Workspaces({ AppDb.open(context, it) }, engine, transport)
    }
}
