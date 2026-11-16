import CarPlay
import GRDB
import UIKit

/// Builds and keeps the CarPlay templates in sync with the local database. Offline-first: browsing reads from
/// SQLite, playback uses downloaded files or streams. Follows driver-distraction rules: shallow lists, no text
/// entry, large controls (the system Now Playing template).
@MainActor
final class CarPlayController: NSObject, CPNowPlayingTemplateObserver {
    private let ic: CPInterfaceController
    private var workspace: Workspace?
    private var tasks: [Task<Void, Never>] = []
    private let env = AppEnvironment.shared

    private var upNextTemplate: CPListTemplate!
    private var playlistsTemplate: CPListTemplate!
    private var podcastsTemplate: CPListTemplate!
    private var downloadsTemplate: CPListTemplate!
    private var bookmarkConfirmedUntil = Date.distantPast
    private let speeds: [Double] = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5]

    init(interfaceController: CPInterfaceController) {
        ic = interfaceController
        super.init()
    }

    func start() {
        configureNowPlaying()
        env.onWorkspaceChange = { [weak self] ws in self?.bind(ws) }
        bind(env.workspace)
    }

    func stop() {
        tasks.forEach { $0.cancel() }
        tasks = []
        CPNowPlayingTemplate.shared.remove(self)
        env.onWorkspaceChange = nil
    }

    // MARK: root

    private func bind(_ ws: Workspace?) {
        tasks.forEach { $0.cancel() }
        tasks = []
        workspace = ws
        guard let ws else {
            let t = CPListTemplate(title: "Homecast", sections: [CPListSection(items: [staticItem("Open Homecast on your iPhone to sign in", detail: nil)])])
            ic.setRootTemplate(t, animated: false, completion: nil)
            return
        }
        upNextTemplate = CPListTemplate(title: "Up Next", sections: [])
        upNextTemplate.tabTitle = "Up Next"; upNextTemplate.tabImage = UIImage(systemName: "text.line.first.and.arrowtriangle.forward")
        playlistsTemplate = CPListTemplate(title: "Playlists", sections: [])
        playlistsTemplate.tabTitle = "Playlists"; playlistsTemplate.tabImage = UIImage(systemName: "music.note.list")
        podcastsTemplate = CPListTemplate(title: "Podcasts", sections: [])
        podcastsTemplate.tabTitle = "Podcasts"; podcastsTemplate.tabImage = UIImage(systemName: "square.grid.2x2.fill")
        downloadsTemplate = CPListTemplate(title: "Downloads", sections: [])
        downloadsTemplate.tabTitle = "Downloads"; downloadsTemplate.tabImage = UIImage(systemName: "arrow.down.circle.fill")
        let tabs = CPTabBarTemplate(templates: [upNextTemplate, playlistsTemplate, podcastsTemplate, downloadsTemplate])
        ic.setRootTemplate(tabs, animated: false, completion: nil)
        observeData(ws)
    }

    private func observeData(_ ws: Workspace) {
        let uid = ws.user.id
        observe(ws, { d -> [EpisodeItem] in
            let ids = try Playlist.fetchOne(d, key: RecordID.upNext(userId: uid)).map { $0.deleted ? [] : $0.episodeIds } ?? []
            return try d.orderedEpisodeItems(ids: ids)
        }) { [weak self] items in
            guard let self else { return }
            self.upNextTemplate.updateSections([self.episodeSection(items, label: "Up Next", empty: "Nothing in Up Next. Add episodes on your iPhone.")])
        }
        observe(ws, { d -> [Podcast: Int] in
            let subs = try d.subscribedPodcastIds()
            let pods = try Podcast.filter(keys: subs).order(sql: "title COLLATE NOCASE").fetchAll(d)
            let rows = try Row.fetchAll(d, sql: "SELECT e.podcastId AS pid, COUNT(*) AS n FROM episode e LEFT JOIN episodeState s ON s.episodeId = e.id AND s.deleted = 0 WHERE (s.status IS NULL OR s.status != 'played') GROUP BY e.podcastId")
            let counts = Dictionary(uniqueKeysWithValues: rows.map { (($0["pid"] as String), ($0["n"] as Int)) })
            return Dictionary(uniqueKeysWithValues: pods.map { ($0, counts[$0.id] ?? 0) })
        }) { [weak self] map in
            guard let self else { return }
            let sorted = map.keys.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
            let items = sorted.map { p -> CPListItem in
                let n = map[p] ?? 0
                let item = CPListItem(text: p.title, detailText: n > 0 ? "\(n) unplayed" : p.author, image: self.placeholder, accessoryImage: nil, accessoryType: .disclosureIndicator)
                self.loadImage(p.imageUrl, into: item)
                item.handler = { [weak self] _, done in self?.showPodcast(p); done() }
                return item
            }
            self.podcastsTemplate.updateSections([CPListSection(items: items.isEmpty ? [self.staticItem("No podcasts yet", detail: "Add some on your iPhone")] : Array(items.prefix(CPListTemplate.maximumItemCount)))])
        }
        observe(ws, { d -> ([Playlist], [SmartPlaylist]) in
            (try Playlist.filter(Column("deleted") == false).filter(Column("name") != RecordID.upNextName).order(sql: "name COLLATE NOCASE").fetchAll(d),
             try SmartPlaylist.filter(Column("deleted") == false).order(sql: "name COLLATE NOCASE").fetchAll(d))
        }) { [weak self] lists in
            guard let self else { return }
            let manual = lists.0.map { p -> CPListItem in
                let item = CPListItem(text: p.name, detailText: "\(p.episodeIds.count) episodes", image: UIImage(systemName: "music.note.list"), accessoryImage: nil, accessoryType: .disclosureIndicator)
                item.handler = { [weak self] _, done in self?.showEpisodes(title: p.name) { d in try d.orderedEpisodeItems(ids: (try Playlist.fetchOne(d, key: p.id))?.episodeIds ?? []) }; done() }
                return item
            }
            let smart = lists.1.map { p -> CPListItem in
                let item = CPListItem(text: p.name, detailText: "Smart playlist", image: UIImage(systemName: "wand.and.stars"), accessoryImage: nil, accessoryType: .disclosureIndicator)
                item.handler = { [weak self] _, done in
                    self?.showEpisodes(title: p.name) { d in
                        guard let sp = try SmartPlaylist.fetchOne(d, key: p.id) else { return [] }
                        return try d.orderedEpisodeItems(ids: SmartEvaluator.evaluate(sp.definition, episodes: try d.episodeViews(), now: LocalData.nowMs()))
                    }
                    done()
                }
                return item
            }
            var sections: [CPListSection] = []
            if !manual.isEmpty { sections.append(CPListSection(items: manual, header: "Playlists", sectionIndexTitle: nil)) }
            if !smart.isEmpty { sections.append(CPListSection(items: smart, header: "Smart playlists", sectionIndexTitle: nil)) }
            if sections.isEmpty { sections = [CPListSection(items: [self.staticItem("No playlists yet", detail: "Create them on your iPhone")])] }
            self.playlistsTemplate.updateSections(sections)
        }
        observe(ws, { d -> [EpisodeItem] in
            try d.orderedEpisodeItems(ids: try Download.order(Column("at").desc).fetchAll(d).map(\.episodeId))
        }) { [weak self] items in
            guard let self else { return }
            self.downloadsTemplate.updateSections([self.episodeSection(items, label: "Downloads", empty: "No downloads. Download episodes on your iPhone to listen offline.")])
        }
    }

    private func observe<T: Sendable>(_ ws: Workspace, _ fetch: @escaping @Sendable (Database) throws -> T, apply: @escaping @MainActor (T) -> Void) {
        let t = Task { @MainActor in
            do { for try await v in ValueObservation.tracking(fetch).values(in: ws.db.pool) { apply(v) } } catch {}
        }
        tasks.append(t)
    }

    // MARK: lists

    private var placeholder: UIImage { UIImage(systemName: "waveform") ?? UIImage() }

    private func staticItem(_ text: String, detail: String?) -> CPListItem {
        let i = CPListItem(text: text, detailText: detail)
        i.isEnabled = false
        return i
    }

    private func loadImage(_ urlString: String?, into item: CPListItem) {
        guard let s = urlString, let url = URL(string: s) else { return }
        if let hit = ImageCache.shared.cached(url) { item.setImage(hit); return }
        Task { if let img = await ImageCache.shared.image(for: url) { item.setImage(img) } }
    }

    private func episodeSection(_ items: [EpisodeItem], label: String, empty: String) -> CPListSection {
        guard !items.isEmpty else { return CPListSection(items: [staticItem(empty, detail: nil)]) }
        let ids = items.map(\.id)
        let current = workspace?.player.episode?.id
        let rows = items.prefix(CPListTemplate.maximumItemCount).map { item -> CPListItem in
            let e = item.episode
            var detail = [item.podcast?.title ?? "", Fmt.released(e.releasedDate)]
            if item.status == .inProgress { detail.append("\(Fmt.duration(item.remainingSec)) left") } else if e.durationSec > 0 { detail.append(Fmt.duration(e.durationSec)) }
            let li = CPListItem(text: e.title, detailText: detail.filter { !$0.isEmpty }.joined(separator: " · "), image: placeholder, accessoryImage: item.downloaded ? UIImage(systemName: "arrow.down.circle.fill") : nil, accessoryType: .none)
            loadImage(item.podcast?.imageUrl, into: li)
            li.isPlaying = e.id == current
            if item.status == .inProgress { li.playbackProgress = item.progress }
            li.handler = { [weak self] _, done in self?.play(e.id, ids: ids, label: label); done() }
            return li
        }
        return CPListSection(items: Array(rows))
    }

    private func showPodcast(_ p: Podcast) {
        showEpisodes(title: p.title) { d in
            let eps = try Episode.filter(Column("podcastId") == p.id).order(Column("releasedAt").desc).limit(60).fetchAll(d)
            let items = try d.episodeItems(eps)
            // Unplayed first, newest first: what you'd want in the car.
            return items.filter { $0.status != .played } + items.filter { $0.status == .played }
        }
    }

    private func showEpisodes(title: String, _ fetch: @escaping @Sendable (Database) throws -> [EpisodeItem]) {
        guard let ws = workspace else { return }
        let t = CPListTemplate(title: title, sections: [])
        let items = (try? ws.db.pool.read(fetch)) ?? []
        t.updateSections([episodeSection(items, label: title, empty: "No episodes")])
        ic.pushTemplate(t, animated: true, completion: nil)
        observe(ws, fetch) { [weak self, weak t] items in
            guard let self, let t else { return }
            t.updateSections([self.episodeSection(items, label: title, empty: "No episodes")])
        }
    }

    private func play(_ id: String, ids: [String], label: String) {
        guard let ws = workspace else { return }
        Task {
            await ws.player.play(id, in: ids, label: label)
            if ic.topTemplate !== CPNowPlayingTemplate.shared { ic.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil) }
        }
    }

    // MARK: Now Playing: speed + bookmark (spec §3.12)

    private func configureNowPlaying() {
        let np = CPNowPlayingTemplate.shared
        np.add(self)
        np.isUpNextButtonEnabled = true
        np.upNextTitle = "Up Next"
        refreshNowPlayingButtons()
    }

    private func refreshNowPlayingButtons() {
        let rate = CPNowPlayingPlaybackRateButton { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let p = self.workspace?.player else { return }
                let next = self.speeds.first { $0 > p.speed + 0.01 } ?? self.speeds[0]
                p.setSpeed(next, scope: .podcast)
            }
        }
        let confirmed = Date() < bookmarkConfirmedUntil
        let bookmark = CPNowPlayingImageButton(image: UIImage(systemName: confirmed ? "checkmark.circle.fill" : "bookmark.fill") ?? UIImage()) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let p = self.workspace?.player, p.hasEpisode else { return }
                p.addBookmarkAtCurrent()
                self.bookmarkConfirmedUntil = Date().addingTimeInterval(2.5)
                self.refreshNowPlayingButtons()
                Task { try? await Task.sleep(for: .seconds(2.6)); self.refreshNowPlayingButtons() }
            }
        }
        CPNowPlayingTemplate.shared.updateNowPlayingButtons([rate, bookmark])
    }

    nonisolated func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        Task { @MainActor in
            if let t = self.upNextTemplate { self.ic.pushTemplate(t, animated: true, completion: nil) }
        }
    }
    nonisolated func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        Task { @MainActor in
            if let id = self.workspace?.player.podcast, let p = try? self.workspace?.db.pool.read({ try Podcast.fetchOne($0, key: id.id) }) { self.showPodcast(p) }
        }
    }
}
