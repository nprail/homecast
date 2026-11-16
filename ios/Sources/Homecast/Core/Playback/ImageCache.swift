import SwiftUI
import UIKit

/// Small in-memory + URLCache-backed image loader for artwork (podcast covers). Used by SwiftUI and Now Playing / CarPlay.
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let cache = NSCache<NSURL, UIImage>()
    private let session: URLSession

    init() {
        cache.countLimit = 300
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 20_000_000, diskCapacity: 200_000_000)
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        session = URLSession(configuration: cfg)
    }

    func cached(_ url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }

    func image(for url: URL) async -> UIImage? {
        if let hit = cache.object(forKey: url as NSURL) { return hit }
        guard let (data, _) = try? await session.data(from: url), let img = UIImage(data: data) else { return nil }
        // Decode off the main thread so scrolling stays smooth.
        let prepared = await img.byPreparingForDisplay() ?? img
        cache.setObject(prepared, forKey: url as NSURL)
        return prepared
    }
}

/// Podcast artwork with a brand-tinted placeholder.
struct Artwork: View {
    let url: String?
    var title: String = ""
    var cornerRadius: CGFloat = 14
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                LinearGradient(colors: [Brand.accentSoft, Brand.raised], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .overlay(HomecastMark().stroke(Brand.accent.opacity(0.55), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)).padding(14))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(.rect(cornerRadius: cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(.white.opacity(0.08), lineWidth: 0.5))
        .accessibilityHidden(true)
        .task(id: url) {
            guard let url, let u = URL(string: url) else { image = nil; return }
            if let hit = ImageCache.shared.cached(u) { image = hit; return }
            image = await ImageCache.shared.image(for: u)
        }
    }
}
