import GRDB
import SwiftUI

/// Podcasts other users on this server follow (spec §3.10). Subscriber *counts* only, never who. Private feeds are never listed.
struct DiscoverView: View {
    @Environment(Workspace.self) private var ws
    @State private var items: [DiscoverItem] = []
    @State private var query = ""
    @State private var sort = "subscribers"
    @State private var loading = false
    @State private var offline = false
    @State private var subscribed = Set<String>()
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 12) {
                    if offline {
                        Label("Offline. Showing the last list you loaded.", systemImage: "wifi.slash").font(.system(size: 13, weight: .semibold)).foregroundStyle(Brand.amber)
                            .padding(.horizontal, 16).frame(height: 40).glassEffect(.regular, in: .capsule)
                    }
                    ForEach(items) { item in card(item) }
                    if items.isEmpty && loaded && !loading {
                        EmptyState(icon: "sparkle.magnifyingglass", title: query.isEmpty ? "Nothing to discover yet" : "No matches", message: query.isEmpty ? "When other people on this server follow podcasts, they show up here." : "Try a different search.")
                    }
                }
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 24)
            }
            .navigationTitle("Discover")
            .searchable(text: $query, prompt: "Search title or author")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Sort", selection: $sort) {
                            Text("Most followed").tag("subscribers"); Text("Recently added").tag("recent"); Text("A to Z").tag("az")
                        }
                    } label: { Image(systemName: "arrow.up.arrow.down") }
                    .accessibilityLabel("Sort")
                }
            }
            .overlay { if loading && items.isEmpty { ProgressView() } }
            .refreshable { await load() }
            .task(id: "\(query)|\(sort)") {
                if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
                if !Task.isCancelled { await load() }
            }
            .brandScreen()
            .routes()
        }
        .onAppear { refreshSubscribed() }
    }

    private func card(_ item: DiscoverItem) -> some View {
        let isSub = subscribed.contains(item.id)
        return HStack(alignment: .top, spacing: 14) {
            Artwork(url: item.imageUrl, cornerRadius: 18).frame(width: 84, height: 84)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Brand.text).lineLimit(2)
                Text(item.author).font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(1)
                Label(Fmt.plural(item.subscriberCount, "subscriber"), systemImage: "person.2.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.accent).padding(.top, 1)
                if !item.description.isEmpty { Text(Fmt.plainText(item.description)).font(.system(size: 13)).foregroundStyle(Brand.muted).lineLimit(2) }
            }
            Spacer(minLength: 0)
            Button { Task { await subscribe(item) } } label: {
                Image(systemName: isSub ? "checkmark" : "plus").font(.system(size: 15, weight: .bold)).foregroundStyle(isSub ? Brand.accent : Brand.ink).frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .glassEffect(isSub ? .regular : .regular.tint(Brand.accent).interactive(), in: .circle)
            .disabled(isSub).accessibilityLabel(isSub ? "Subscribed" : "Subscribe to \(item.title)")
        }
        .padding(14).glassEffect(.regular, in: .rect(cornerRadius: 26))
    }

    private func refreshSubscribed() { subscribed = (try? ws.db.pool.read { try $0.subscribedPodcastIds() }) ?? [] }

    private func load() async {
        loading = true
        defer { loading = false; loaded = true }
        var path = "/discover?sort=\(sort)&limit=100"
        if let q = query.trimmedOrNil, let e = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "&q=\(e)" }
        do {
            let r: DiscoverResponse = try await ws.api.get(path)
            items = r.items; offline = false
            if query.isEmpty, sort == "subscribers" { ws.db.setKVJSON("discover.cache", r.items.map { CachedDiscover($0) }) }
        } catch {
            if error is NetworkError || (error as? APIError) == nil {
                offline = true
                if items.isEmpty, let cached = ws.db.kvJSON("discover.cache", as: [CachedDiscover].self) { items = cached.map(\.item) }
            }
        }
        refreshSubscribed()
    }

    private func subscribe(_ item: DiscoverItem) async {
        do {
            let _: EmptyResponse = try await ws.api.post("/subscriptions", json: ["podcastId": item.id])
            ws.data.ensureSubscriptionLocal(item.id)
            subscribed.insert(item.id)
            Haptics.success()
            Toaster.shared.show("Subscribed to \(item.title)")
            await ws.sync.sync()
        } catch is NetworkError { Toaster.shared.show("You need a connection to subscribe") }
        catch { Toaster.shared.show(error.localizedDescription) }
    }
}

/// Last Discover list, cached so it can be browsed offline.
struct CachedDiscover: Codable {
    var id: String, title: String, author: String, imageUrl: String?, description: String, subscriberCount: Int, addedAt: Double
    init(_ d: DiscoverItem) { id = d.id; title = d.title; author = d.author; imageUrl = d.imageUrl; description = d.description; subscriberCount = d.subscriberCount; addedAt = d.addedAt }
    var item: DiscoverItem { DiscoverItem(id: id, title: title, author: author, imageUrl: imageUrl, description: description, subscriberCount: subscriberCount, addedAt: addedAt) }
}
