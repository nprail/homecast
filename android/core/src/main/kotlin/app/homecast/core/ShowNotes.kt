package app.homecast.core

/** A piece of show notes: plain text, a link, or a timestamp that jumps in the episode. */
sealed interface NoteSegment {
    data class Text(val text: String) : NoteSegment
    data class Link(val text: String, val url: String) : NoteSegment
    data class Time(val text: String, val ms: Long) : NoteSegment
}

/**
 * Finds links and timestamps in show notes. Same rules as shared/src/showNotes.ts
 * (vectors: shared/vectors/show-notes.json).
 */
object ShowNotes {
    /** A web address, or a timestamp ([h:]m:ss) that is not part of a longer word or number and not a time of day. */
    private val token = Regex("""(?:https?://|www\.)[^\s<>"']+|(?<![A-Za-z0-9_:/.])(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?![A-Za-z0-9_:])(?!\s?[AaPp]\.?[Mm])""")
    private val anchor = Regex("""<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE)

    private fun trimUrl(raw: String): String {
        var u = raw
        fun count(c: Char) = u.count { it == c }
        while (u.isNotEmpty()) {
            val last = u.last()
            u = when {
                last in ".,;:!?'\"" -> u.dropLast(1)
                last == ')' && count('(') < count(')') -> u.dropLast(1)
                last == ']' && count('[') < count(']') -> u.dropLast(1)
                else -> return u
            }
        }
        return u
    }

    /** Splits plain text into text, link and timestamp segments. Timestamps past [durationMs] (when known) stay text. */
    fun linkify(text: String, durationMs: Long = 0): List<NoteSegment> {
        val out = ArrayList<NoteSegment>()
        fun push(s: NoteSegment) {
            if (s is NoteSegment.Text) {
                if (s.text.isEmpty()) return
                val p = out.lastOrNull()
                if (p is NoteSegment.Text) { out[out.size - 1] = NoteSegment.Text(p.text + s.text); return }
            }
            out.add(s)
        }
        var last = 0
        for (m in token.findAll(text)) {
            var raw = m.value
            val seg: NoteSegment
            if (m.groups[2] == null) {
                raw = trimUrl(raw)
                if (raw.length < 8) continue
                seg = NoteSegment.Link(raw, if (raw.startsWith("www.")) "https://$raw" else raw)
            } else {
                val h = m.groups[1]?.value?.toLong() ?: 0L
                val ms = ((h * 60 + m.groups[2]!!.value.toLong()) * 60 + m.groups[3]!!.value.toLong()) * 1000
                if (durationMs > 0 && ms > durationMs) continue
                seg = NoteSegment.Time(raw, ms)
            }
            push(NoteSegment.Text(text.substring(last, m.range.first)))
            push(seg)
            last = m.range.first + raw.length
        }
        push(NoteSegment.Text(text.substring(last)))
        return out
    }

    private fun plain(html: String): String {
        var s = html.replace(Regex("<br\\s*/?>|</p>|</li>", RegexOption.IGNORE_CASE), "\n").replace(Regex("<[^>]+>"), "")
        listOf("&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'", "&apos;" to "'", "&nbsp;" to " ", "&amp;" to "&").forEach { (k, v) -> s = s.replace(k, v) }
        return s.replace(Regex("\n{3,}"), "\n\n")
    }

    /** Show notes HTML to segments: tags dropped, `<a href>` (http, https, mailto) kept as links, bare URLs and timestamps found. */
    fun parse(html: String, durationMs: Long = 0): List<NoteSegment> {
        val out = ArrayList<NoteSegment>()
        fun add(segs: List<NoteSegment>) {
            for (s in segs) {
                val p = out.lastOrNull()
                if (s is NoteSegment.Text && p is NoteSegment.Text) out[out.size - 1] = NoteSegment.Text(p.text + s.text) else out.add(s)
            }
        }
        var last = 0
        for (m in anchor.findAll(html)) {
            add(linkify(plain(html.substring(last, m.range.first)), durationMs))
            val url = plain(m.groups[1]?.value ?: m.groups[2]?.value ?: "").trim()
            val label = plain(m.groups[3]?.value ?: "").trim()
            if (Regex("^(https?:|mailto:)", RegexOption.IGNORE_CASE).containsMatchIn(url)) add(listOf(NoteSegment.Link(label.ifEmpty { url }, url)))
            else add(linkify(label, durationMs))
            last = m.range.last + 1
        }
        add(linkify(plain(html.substring(last)), durationMs))
        (out.firstOrNull() as? NoteSegment.Text)?.let { out[0] = NoteSegment.Text(it.text.trimStart()) }
        (out.lastOrNull() as? NoteSegment.Text)?.let { out[out.size - 1] = NoteSegment.Text(it.text.trimEnd()) }
        return out.filter { it !is NoteSegment.Text || it.text.isNotEmpty() }
    }
}
