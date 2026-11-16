package app.homecast.core

import app.homecast.contract.*
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs shared/vectors/smart-playlist.json: identical ids in identical order on every platform. */
class SmartEvaluatorVectorTest {
    private val root = HcJson.parseToJsonElement(
        javaClass.classLoader!!.getResourceAsStream("smart-playlist.json")!!.bufferedReader().readText(),
    ).jsonObject

    private fun views(): List<EpisodeView> = root["episodes"]!!.jsonArray.map {
        val o = it.jsonObject
        EpisodeView(
            o["id"]!!.jsonPrimitive.content, o["podcastId"]!!.jsonPrimitive.content, o["title"]!!.jsonPrimitive.content,
            o["releasedAt"]!!.jsonPrimitive.long, o["durationSec"]!!.jsonPrimitive.double,
            PlayStatus.fromWire(o["status"]!!.jsonPrimitive.content), o["downloaded"]!!.jsonPrimitive.boolean, o["starred"]!!.jsonPrimitive.boolean,
        )
    }

    @Test fun allVectorCasesMatch() {
        val now = root["now"]!!.jsonPrimitive.long
        val episodes = views()
        val cases = root["cases"]!!.jsonArray
        assertTrue(cases.size >= 8)
        for (c in cases) {
            val o = c.jsonObject
            val def = HcJson.decodeFromJsonElement(SmartPlaylistDefinition.serializer(), o["definition"]!!)
            val expected = o["expected"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(o["name"]!!.jsonPrimitive.content, expected, SmartEvaluator.evaluate(def, episodes, now))
        }
    }

    @Test fun definitionRoundTripsToServerShape() {
        val def = SmartPlaylistDefinition.blank("x")
        val json = HcJson.encodeToJsonElement(SmartPlaylistDefinition.serializer(), def).jsonObject
        assertEquals("all", json["match"]!!.jsonPrimitive.content)
        val rule = json["rules"]!!.jsonArray[0].jsonObject
        assertEquals(setOf("field", "op", "value"), rule.keys)
        assertEquals("releasedAt", json["sort"]!!.jsonObject["field"]!!.jsonPrimitive.content)
        assertEquals(50, json["limit"]!!.jsonPrimitive.int)
    }

    @Test fun titleSortIgnoresCaseAndDiacriticsAndBreaksTiesOnId() {
        fun v(id: String, t: String) = EpisodeView(id, "p", t, 0, 0.0, PlayStatus.Unplayed, false, false)
        val def = SmartPlaylistDefinition("x", SmartMatch.All, emptyList(), SmartSort(SortField.Title, SortDir.Asc), null, null)
        val ids = SmartEvaluator.evaluate(def, listOf(v("3", "Zebra"), v("2", "écoute"), v("1", "Ecoute"), v("4", "apple")), 0)
        assertEquals(listOf("4", "1", "2", "3"), ids)
        val desc = def.copy(sort = SmartSort(SortField.Title, SortDir.Desc))
        assertEquals(listOf("3", "1", "2", "4"), SmartEvaluator.evaluate(desc, listOf(v("3", "Zebra"), v("2", "écoute"), v("1", "Ecoute"), v("4", "apple")), 0))
    }
}
