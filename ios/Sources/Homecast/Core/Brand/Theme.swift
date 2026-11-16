import SwiftUI

/// Homecast brand tokens (mirrors the player PWA's dark theme: web/src/index.css `--color-p-*`).
/// Teal + amber on deep ink, Space Grotesk for display type, system fonts for body text, and iOS 26
/// Liquid Glass for every floating control surface.
enum Brand {
    static let bg = Color(hex: 0x0E1014)
    static let side = Color(hex: 0x12151B)
    static let surface = Color(hex: 0x171A21)
    static let raised = Color(hex: 0x1F232C)
    static let line = Color(hex: 0x2A2F3A)
    static let text = Color(hex: 0xF1F3F7)
    static let muted = Color(hex: 0xA3ABBA)
    static let accent = Color(hex: 0x4FD1C5)
    static let ink = Color(hex: 0x04201D)
    static let accentSoft = Color(hex: 0x12302F)
    static let amber = Color(hex: 0xF5B544)
    static let amberSoft = Color(hex: 0x3A2C10)
    static let danger = Color(hex: 0xF08A8A)
    static let grip = Color(hex: 0x4A5160)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

extension Font {
    /// Space Grotesk, the Homecast display face (wordmark, headings, numerals).
    static func display(_ size: CGFloat, weight: Font.Weight = .bold, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom(weight == .bold || weight == .heavy || weight == .semibold ? "SpaceGrotesk-Bold" : "SpaceGrotesk-Medium", size: size, relativeTo: style)
    }
}

/// The ambient backdrop behind every screen: ink with soft teal and amber glows so the glass has colour to refract.
struct BrandBackdrop: View {
    var tint: Color = Brand.accent
    var body: some View {
        ZStack {
            Brand.bg
            RadialGradient(colors: [tint.opacity(0.26), .clear], center: .init(x: 0.1, y: -0.05), startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Brand.amber.opacity(0.10), .clear], center: .init(x: 1.0, y: 0.55), startRadius: 0, endRadius: 360)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// Standard screen chrome: brand backdrop and hidden default list/scroll backgrounds.
    func brandScreen() -> some View {
        self.scrollContentBackground(.hidden)
            .background(BrandBackdrop())
            .tint(Brand.accent)
    }

    /// A glass card (rounded rect) for grouped content.
    func glassCard(cornerRadius: CGFloat = 22, tint: Color? = nil) -> some View {
        self.glassEffect(tint.map { .regular.tint($0.opacity(0.18)) } ?? .regular, in: .rect(cornerRadius: cornerRadius))
    }
}

/// Small uppercase section label used across screens (same treatment as the PWA).
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .tracking(0.9)
            .foregroundStyle(Brand.muted)
    }
}

/// The Homecast mark (waveform roof on a floor line) drawn natively from `logo/homecast-mark.svg`.
struct HomecastMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 64
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(4, 42)); path.addLine(to: p(15, 42)); path.addLine(to: p(21, 30)); path.addLine(to: p(27, 50))
        path.addLine(to: p(34, 12)); path.addLine(to: p(41, 48)); path.addLine(to: p(46, 34)); path.addLine(to: p(49, 42)); path.addLine(to: p(60, 42))
        return path
    }
}

struct HomecastLogo: View {
    var size: CGFloat = 64
    var body: some View {
        ZStack {
            HomecastMark().stroke(Brand.accent, style: StrokeStyle(lineWidth: size * 3.5 / 64, lineCap: .round, lineJoin: .round))
            Path { p in
                let s = size / 64
                p.move(to: CGPoint(x: 14 * s, y: 56 * s)); p.addLine(to: CGPoint(x: 50 * s, y: 56 * s))
            }
            .stroke(Brand.amber, style: StrokeStyle(lineWidth: size * 3.5 / 64, lineCap: .round))
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Homecast")
    }
}

/// Subtle haptics for primary actions.
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}
