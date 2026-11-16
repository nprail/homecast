package app.homecast.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import coil3.compose.SubcomposeAsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import app.homecast.android.ui.theme.Brand

/** The Homecast mark (waveform roof on a floor line), drawn from logo/homecast-mark.svg. */
@Composable
fun HomecastLogo(size: Dp = 64.dp, modifier: Modifier = Modifier, wave: Color = Brand.Teal, floor: Color = Brand.Amber) {
    Canvas(modifier.size(size)) {
        val s = this.size.minDimension / 64f
        val stroke = Stroke(width = 3.5f * s, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val p = Path().apply {
            moveTo(4 * s, 42 * s); lineTo(15 * s, 42 * s); lineTo(21 * s, 30 * s); lineTo(27 * s, 50 * s); lineTo(34 * s, 12 * s)
            lineTo(41 * s, 48 * s); lineTo(46 * s, 34 * s); lineTo(49 * s, 42 * s); lineTo(60 * s, 42 * s)
        }
        drawPath(p, wave, style = stroke)
        drawLine(floor, Offset(14 * s, 56 * s), Offset(50 * s, 56 * s), strokeWidth = 3.5f * s, cap = StrokeCap.Round)
    }
}

/** Podcast artwork with a brand-tinted placeholder. */
@Composable
fun Artwork(url: String?, modifier: Modifier = Modifier, cornerRadius: Dp = 14.dp, contentDescription: String? = null) {
    val shape = RoundedCornerShape(cornerRadius)
    val placeholder: @Composable () -> Unit = {
        Box(
            Modifier.fillMaxSize().background(Brush.linearGradient(listOf(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.surfaceVariant))),
            contentAlignment = Alignment.Center,
        ) { HomecastLogo(size = 28.dp, wave = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f), floor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.5f)) }
    }
    Box(modifier.aspectRatio(1f).clip(shape)) {
        if (url == null) placeholder() else SubcomposeAsyncImage(
            model = ImageRequest.Builder(LocalContext.current).data(url).crossfade(true).build(),
            contentDescription = contentDescription,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            loading = { placeholder() },
            error = { placeholder() },
        )
    }
}

/** Small uppercase section label. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(), modifier, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
fun EmptyState(icon: ImageVector, title: String, message: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(80.dp).clip(RoundedCornerShape(28.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.primary)
        }
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null) { Spacer(Modifier.height(4.dp)); action() }
    }
}

/** Thin brand progress bar used in rows. */
@Composable
fun ProgressTrack(value: Float, modifier: Modifier = Modifier, height: Dp = 3.dp) {
    Box(modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.outlineVariant)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(value.coerceIn(0f, 1f)).background(MaterialTheme.colorScheme.primary))
    }
}

/** Formatting shared by every screen. */
object Fmt {
    /** "1 hr 4 min", "37 min", "<1 min". */
    fun duration(sec: Double): String {
        val m = Math.round(sec / 60.0).toInt()
        if (m <= 0) return if (sec > 0) "<1 min" else ""
        if (m < 60) return "$m min"
        val h = m / 60; val r = m % 60
        return if (r == 0) "$h hr" else "$h hr $r min"
    }
    /** Scrubber clock: 3:07 or 1:03:07. */
    fun clock(ms: Long): String {
        val s = maxOf(0L, ms / 1000)
        val h = s / 3600; val m = (s % 3600) / 60; val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }
    fun speed(s: Double): String {
        val r = Math.round(s * 10) / 10.0
        return (if (r == Math.floor(r)) "%.0f".format(r) else "%.1f".format(r)) + "×"
    }
    fun released(epochMs: Long, now: Long = System.currentTimeMillis()): String {
        val days = ((now - epochMs) / 86_400_000L).toInt()
        return when {
            days < 1 -> "Today"
            days == 1 -> "Yesterday"
            days < 7 -> "$days days ago"
            else -> java.text.SimpleDateFormat("MMM d", java.util.Locale.getDefault()).format(java.util.Date(epochMs))
        }
    }
    fun bytes(n: Long): String = when {
        n >= 1_000_000_000 -> "%.1f GB".format(n / 1e9)
        n >= 1_000_000 -> "%.1f MB".format(n / 1e6)
        n >= 1_000 -> "%.0f KB".format(n / 1e3)
        else -> "$n B"
    }
    fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"
    fun sleepRemaining(ms: Long): String {
        val t = Math.ceil(ms / 1000.0).toInt()
        return if (t >= 3600) "%d:%02d:%02d".format(t / 3600, (t % 3600) / 60, t % 60) else "%d:%02d".format(t / 60, t % 60)
    }
    /** Feed descriptions are HTML: strip to plain text (spec §7: never render feed HTML raw). */
    fun plainText(html: String): String {
        var s = html.replace(Regex("<br\\s*/?>|</p>|</li>"), "\n").replace(Regex("<[^>]+>"), "")
        listOf("&amp;" to "&", "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'", "&nbsp;" to " ", "&apos;" to "'").forEach { (k, v) -> s = s.replace(k, v) }
        return s.replace(Regex("\n{3,}"), "\n\n").trim()
    }
}
