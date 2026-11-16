package app.homecast.core

import kotlinx.serialization.json.Json

/** Shared JSON configuration. Nulls are omitted on the wire (zod `optional()` fields reject nothing, but `positionUpdatedAt: null` would fail). */
val HcJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
    isLenient = true
}
