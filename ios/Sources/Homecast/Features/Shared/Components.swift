import SwiftUI

/// Where a screen sends the user. One enum keeps every NavigationStack's destinations identical.
enum Route: Hashable {
    case podcast(String)
    case episode(String)
    case playlist(String)
    case smartPlaylist(String)
    case bookmarks
    case starred
    case latest
}

/// Transient confirmation, shown as a glass capsule.
@MainActor @Observable
final class Toaster {
    static let shared = Toaster()
    private(set) var message: String?
    private var task: Task<Void, Never>?
    func show(_ text: String) {
        message = text
        task?.cancel()
        task = Task { try? await Task.sleep(for: .seconds(2.4)); if !Task.isCancelled { message = nil } }
    }
}

struct ToastHost: ViewModifier {
    @State private var toaster = Toaster.shared
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let m = toaster.message {
                Text(m)
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular.tint(Brand.accent.opacity(0.25)), in: .capsule)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.spring(duration: 0.35), value: toaster.message)
    }
}
extension View { func toastHost() -> some View { modifier(ToastHost()) } }

struct EmptyState: View {
    let icon: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 34, weight: .regular)).foregroundStyle(Brand.accent)
                .frame(width: 76, height: 76).glassEffect(.regular, in: .circle)
            Text(title).font(.display(22)).foregroundStyle(Brand.text)
            Text(message).font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.center).frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 56).padding(.horizontal, 24)
    }
}

/// A thin brand progress bar used in rows.
struct ProgressTrack: View {
    let value: Double
    var height: CGFloat = 3
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.14))
                Capsule().fill(Brand.accent).frame(width: max(0, min(1, value)) * g.size.width)
            }
        }
        .frame(height: height)
    }
}

/// Circular download progress / state badge.
struct DownloadBadge: View {
    let downloaded: Bool
    let progress: Double?
    var body: some View {
        if downloaded {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(Brand.accent).accessibilityLabel("Downloaded")
        } else if let progress {
            ZStack {
                Circle().stroke(.white.opacity(0.2), lineWidth: 2)
                if progress >= 0 { Circle().trim(from: 0, to: progress).stroke(Brand.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90)) }
                else { ProgressView().controlSize(.mini) }
            }
            .frame(width: 14, height: 14).accessibilityLabel("Downloading")
        }
    }
}

struct PrimaryActionButton: View {
    let title: String
    var systemImage: String?
    var tint: Color = Brand.accent
    var busy = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(Brand.ink) } else if let systemImage { Image(systemName: systemImage) }
                Text(title).font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(Brand.ink)
            .frame(maxWidth: .infinity, minHeight: 28)
        }
        .buttonStyle(.glassProminent)
        .tint(tint)
        .controlSize(.large)
        .disabled(busy)
    }
}
