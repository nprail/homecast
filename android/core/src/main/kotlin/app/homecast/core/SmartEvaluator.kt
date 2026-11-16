package app.homecast.core

import app.homecast.contract.*
import java.text.Normalizer

/**
 * Smart-playlist rules (spec §3.7), evaluated on-device. Port of shared/src/smartPlaylist.ts / the iOS `SmartEvaluator`:
 * identical ids in identical order for shared/vectors/smart-playlist.json. Ties break on id.
 */
object SmartEvaluator {
    fun matches(rule: SmartRule, ep: EpisodeView, now: Long): Boolean = when (rule) {
        is SmartRule.PodcastIn -> ep.podcastId in rule.ids
        is SmartRule.PodcastNotIn -> ep.podcastId !in rule.ids
        is SmartRule.Status -> ep.status == rule.status
        is SmartRule.ReleasedWithin -> ep.releasedAt.toDouble() >= now.toDouble() - rule.days * 86_400_000.0 && ep.releasedAt <= now
        is SmartRule.DurationLessThan -> ep.durationSec / 60 < rule.minutes
        is SmartRule.DurationGreaterThan -> ep.durationSec / 60 > rule.minutes
        is SmartRule.Downloaded -> ep.downloaded == rule.value
        is SmartRule.Starred -> ep.starred == rule.value
        is SmartRule.TitleContains -> ep.title.lowercase().contains(rule.text.lowercase())
    }

    /** Episode ids in order. An empty rule list matches every episode. */
    fun evaluate(def: SmartPlaylistDefinition, episodes: List<EpisodeView>, now: Long): List<String> {
        val matched = episodes.filter { ep ->
            when {
                def.rules.isEmpty() -> true
                def.match == SmartMatch.All -> def.rules.all { matches(it, ep, now) }
                else -> def.rules.any { matches(it, ep, now) }
            }
        }
        val dir = if (def.sort.dir == SortDir.Asc) 1 else -1
        val sorted = matched.sortedWith { a, b ->
            // The id tiebreak is ascending regardless of the sort direction.
            val c = when (def.sort.field) {
                SortField.Title -> compareTitles(a.title, b.title)
                SortField.Duration -> a.durationSec.compareTo(b.durationSec).coerceIn(-1, 1)
                SortField.ReleasedAt -> a.releasedAt.compareTo(b.releasedAt).coerceIn(-1, 1)
            }
            if (c != 0) c * dir else a.id.compareTo(b.id)
        }
        val limited = def.limit?.let { sorted.take(it) } ?: sorted
        return limited.map { it.id }
    }

    /**
     * Case- and diacritic-insensitive comparison approximating ICU root/English collation (whitespace < punctuation <
     * digits < letters). Deterministic on every JVM/Android version, unlike `java.text.Collator`.
     */
    fun compareTitles(a: String, b: String): Int {
        val ka = collationKey(a); val kb = collationKey(b)
        val n = minOf(ka.size, kb.size)
        for (i in 0 until n) if (ka[i] != kb[i]) return if (ka[i] < kb[i]) -1 else 1
        return ka.size.compareTo(kb.size).coerceIn(-1, 1)
    }

    private fun collationKey(s: String): LongArray {
        val folded = Normalizer.normalize(s, Normalizer.Form.NFD)
        val out = ArrayList<Long>(folded.length)
        var i = 0
        while (i < folded.length) {
            val cp = folded.codePointAt(i)
            i += Character.charCount(cp)
            val type = Character.getType(cp)
            if (type == Character.NON_SPACING_MARK.toInt() || type == Character.COMBINING_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt()) continue
            val lower = Character.toLowerCase(cp)
            val cls = when {
                Character.isWhitespace(cp) || Character.isSpaceChar(cp) -> 0L
                Character.isDigit(cp) -> 2L
                Character.isLetter(cp) -> 3L
                else -> 1L
            }
            out.add(cls * 0x200000L + lower)
        }
        return out.toLongArray()
    }
}
