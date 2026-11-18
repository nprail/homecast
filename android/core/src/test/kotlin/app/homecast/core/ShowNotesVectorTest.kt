package app.homecast.core

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs shared/vectors/show-notes.json: the same segments as the TypeScript and Swift parsers. */
class ShowNotesVectorTest {
    private val root = Json.parseToJsonElement(
        javaClass.classLoader!!.getResourceAsStream("show-notes.json")!!.bufferedReader().readText(),
    ).jsonObject

    @Test fun allVectorCasesMatch() {
        val cases = root["cases"]!!.jsonArray
        assertTrue(cases.size > 8)
        for (c in cases) {
            val o = c.jsonObject
            val expected = o["expected"]!!.jsonArray.map {
                val e = it.jsonObject
                val text = e["text"]!!.jsonPrimitive.content
                when (e["type"]!!.jsonPrimitive.content) {
                    "link" -> NoteSegment.Link(text, e["url"]!!.jsonPrimitive.content)
                    "time" -> NoteSegment.Time(text, e["ms"]!!.jsonPrimitive.long)
                    else -> NoteSegment.Text(text)
                }
            }
            assertEquals(o["name"]!!.jsonPrimitive.content, expected, ShowNotes.parse(o["html"]!!.jsonPrimitive.content, o["durationMs"]!!.jsonPrimitive.long))
        }
    }
}
