package app.homecast.android

import androidx.activity.ComponentActivity
import app.homecast.contract.HomecastGraph

/** Release builds carry no debug hooks. */
object DebugHook { fun run(activity: ComponentActivity, graph: HomecastGraph) {} }
