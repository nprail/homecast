package app.homecast.core.db

import androidx.room.TypeConverter
import app.homecast.contract.SmartPlaylistDefinition
import app.homecast.core.HcJson
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement

class Converters {
    @TypeConverter fun fromStrings(v: List<String>): String = HcJson.encodeToString(v)
    @TypeConverter fun toStrings(s: String): List<String> = HcJson.decodeFromString(s)
    @TypeConverter fun fromSpeeds(v: Map<String, Double>): String = HcJson.encodeToString(v)
    @TypeConverter fun toSpeeds(s: String): Map<String, Double> = HcJson.decodeFromString(s)
    @TypeConverter fun fromPrefs(v: Map<String, JsonElement>): String = HcJson.encodeToString(v)
    @TypeConverter fun toPrefs(s: String): Map<String, JsonElement> = HcJson.decodeFromString(s)
    @TypeConverter fun fromSegments(v: List<SegmentW>): String = HcJson.encodeToString(v)
    @TypeConverter fun toSegments(s: String): List<SegmentW> = HcJson.decodeFromString(s)
    @TypeConverter fun fromAutoDownload(v: AutoDownloadW): String = HcJson.encodeToString(v)
    @TypeConverter fun toAutoDownload(s: String): AutoDownloadW = HcJson.decodeFromString(s)
    @TypeConverter fun fromDefinition(v: SmartPlaylistDefinition): String = HcJson.encodeToString(v)
    @TypeConverter fun toDefinition(s: String): SmartPlaylistDefinition = HcJson.decodeFromString(s)
}
