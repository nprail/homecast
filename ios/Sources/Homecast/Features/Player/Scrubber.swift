import SwiftUI

/// The playback scrubber: brand-teal fill, amber bookmark ticks, drag to seek, times underneath.
struct Scrubber: View {
    let positionMs: Int
    let durationMs: Int
    var markers: [Int] = []
    /// Chapter starts, drawn as thin gaps in the track.
    var chapters: [Int] = []
    var speed: Double = 1
    let onSeek: (Int) -> Void
    @State private var dragMs: Int?
    @GestureState private var isDragging = false

    var body: some View {
        let shown = dragMs ?? positionMs
        let frac = durationMs > 0 ? Double(shown) / Double(durationMs) : 0
        VStack(spacing: 8) {
            GeometryReader { g in
                let w = g.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.16))
                    Capsule().fill(LinearGradient(colors: [Brand.accent.opacity(0.85), Brand.accent], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(0, min(1, frac)) * w)
                    ForEach(chapters.filter { $0 > 0 && $0 < durationMs }, id: \.self) { c in
                        Rectangle().fill(Brand.bg).frame(width: 1.5, height: 7).offset(x: CGFloat(c) / CGFloat(durationMs) * w - 0.75)
                    }
                    ForEach(markers, id: \.self) { m in
                        if durationMs > 0 {
                            Capsule().fill(Brand.amber).frame(width: 3, height: isDragging ? 14 : 10)
                                .offset(x: CGFloat(m) / CGFloat(durationMs) * w - 1.5)
                        }
                    }
                    Circle().fill(.white).frame(width: isDragging ? 22 : 14, height: isDragging ? 22 : 14)
                        .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
                        .offset(x: max(0, min(1, frac)) * w - (isDragging ? 11 : 7))
                }
                .frame(height: isDragging ? 10 : 7).frame(maxHeight: .infinity)
                .contentShape(.rect)
                .gesture(DragGesture(minimumDistance: 0)
                    .updating($isDragging) { _, s, _ in s = true }
                    .onChanged { v in dragMs = Int(max(0, min(1, v.location.x / w)) * Double(durationMs)) }
                    .onEnded { v in
                        let ms = Int(max(0, min(1, v.location.x / w)) * Double(durationMs))
                        dragMs = nil
                        onSeek(ms)
                    })
                .animation(.spring(duration: 0.25), value: isDragging)
            }
            .frame(height: 28)
            HStack {
                Text(Fmt.clock(shown))
                Spacer()
                Text("-" + Fmt.clock(max(0, Int(Double(durationMs - shown) / max(speed, 0.1)))))
            }
            .font(.system(size: 12, weight: .medium).monospacedDigit())
            .foregroundStyle(Brand.muted)
        }
        .accessibilityElement()
        .accessibilityLabel("Playback position")
        .accessibilityValue("\(Fmt.clock(shown)) of \(Fmt.clock(durationMs))")
        .accessibilityAdjustableAction { dir in
            onSeek(positionMs + (dir == .increment ? 30_000 : -15_000))
        }
    }
}
