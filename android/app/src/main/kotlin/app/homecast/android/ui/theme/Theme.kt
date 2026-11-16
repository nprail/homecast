package app.homecast.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import app.homecast.android.R

/** Homecast brand tokens (web/src/index.css `--color-p-*`, logo/README.md). Teal + amber on deep ink. */
object Brand {
    val Teal = Color(0xFF4FD1C5)
    val TealDark = Color(0xFF0F766E)
    val Amber = Color(0xFFF5B544)
    val AmberDark = Color(0xFFB7791F)
    val Ink = Color(0xFF04201D)
    val Bg = Color(0xFF0E1014)
}

val SpaceGrotesk = FontFamily(
    Font(R.font.spacegrotesk_medium, FontWeight.Medium),
    Font(R.font.spacegrotesk_bold, FontWeight.Bold),
    Font(R.font.spacegrotesk_bold, FontWeight.SemiBold),
)

private val DarkColors = darkColorScheme(
    primary = Brand.Teal, onPrimary = Brand.Ink,
    primaryContainer = Color(0xFF12302F), onPrimaryContainer = Color(0xFFA7F3EC),
    secondary = Color(0xFF9FD8D2), onSecondary = Brand.Ink,
    secondaryContainer = Color(0xFF1B2E2D), onSecondaryContainer = Color(0xFFCDEFEB),
    tertiary = Brand.Amber, onTertiary = Color(0xFF3A2C10),
    tertiaryContainer = Color(0xFF3A2C10), onTertiaryContainer = Color(0xFFFFDFA0),
    background = Brand.Bg, onBackground = Color(0xFFF1F3F7),
    surface = Color(0xFF12151B), onSurface = Color(0xFFF1F3F7),
    surfaceVariant = Color(0xFF1F232C), onSurfaceVariant = Color(0xFFA3ABBA),
    surfaceTint = Brand.Teal,
    surfaceDim = Color(0xFF0B0D11), surfaceBright = Color(0xFF2A2F3A),
    surfaceContainerLowest = Color(0xFF0B0D11), surfaceContainerLow = Color(0xFF12151B), surfaceContainer = Color(0xFF171A21),
    surfaceContainerHigh = Color(0xFF1F232C), surfaceContainerHighest = Color(0xFF262B35),
    outline = Color(0xFF4A5160), outlineVariant = Color(0xFF2A2F3A),
    error = Color(0xFFF08A8A), onError = Color(0xFF3B0D0D), errorContainer = Color(0xFF4A1F1F), onErrorContainer = Color(0xFFFFD9D9),
    inverseSurface = Color(0xFFF1F3F7), inverseOnSurface = Color(0xFF14171C), inversePrimary = Brand.TealDark,
    scrim = Color(0xFF000000),
)

private val LightColors = lightColorScheme(
    primary = Brand.TealDark, onPrimary = Color.White,
    primaryContainer = Color(0xFFE0F2F1), onPrimaryContainer = Color(0xFF06403B),
    secondary = Color(0xFF4A6360), onSecondary = Color.White,
    secondaryContainer = Color(0xFFCCE8E4), onSecondaryContainer = Color(0xFF06201D),
    tertiary = Brand.AmberDark, onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFDF1D6), onTertiaryContainer = Color(0xFF3A2400),
    background = Color(0xFFF4F5F7), onBackground = Color(0xFF14171C),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF14171C),
    surfaceVariant = Color(0xFFEEF0F3), onSurfaceVariant = Color(0xFF5B6472),
    surfaceTint = Brand.TealDark,
    surfaceDim = Color(0xFFDDE0E5), surfaceBright = Color(0xFFFFFFFF),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFF7F8FA), surfaceContainer = Color(0xFFF0F2F5),
    surfaceContainerHigh = Color(0xFFEAEDF1), surfaceContainerHighest = Color(0xFFE3E6EB),
    outline = Color(0xFFCBD0D8), outlineVariant = Color(0xFFE3E6EB),
    error = Color(0xFF991B1B), onError = Color.White, errorContainer = Color(0xFFFEE2E2), onErrorContainer = Color(0xFF450A0A),
)

private fun display(size: Int, line: Int, weight: FontWeight = FontWeight.Bold, spacing: Double = -0.2) =
    TextStyle(fontFamily = SpaceGrotesk, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = spacing.sp)

/** Material 3 type scale with Space Grotesk for display/headline/title-large and the system face for body and labels. */
private val HomecastTypography = Typography().let { base ->
    base.copy(
        displayLarge = display(57, 64), displayMedium = display(45, 52), displaySmall = display(36, 44),
        headlineLarge = display(32, 40), headlineMedium = display(28, 36), headlineSmall = display(24, 32),
        titleLarge = display(22, 28, FontWeight.Bold, 0.0),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

private val HomecastShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp), extraLarge = RoundedCornerShape(30.dp),
)

@Composable
fun HomecastTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = HomecastTypography,
        shapes = HomecastShapes,
        content = content,
    )
}
