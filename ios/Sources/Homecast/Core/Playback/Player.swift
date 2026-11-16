import AVFoundation
import Combine
import CoreMotion
import MediaPlayer
import Observation
import UIKit

struct PlayContext: Codable, Hashable {
    /// Shown as "Playing from".
    var label: String
    /// When set, playback advances through these ids before falling back to Up Next.
    var ids: [String]?
    static let upNext = PlayContext(label: "Up Next")
}

enum SleepMode: Equatable {
    case off
    case timer(endsAt: Date)
    case endOfEpisode
}

/// The audio engine (spec §3.1, §3.3, §3.4): AVPlayer with background audio, lock-screen / CarPlay controls via
/// `MPNowPlayingInfoCenter` + remote commands, position persisted locally every 5 s and pushed to the server on pause,
/// episode change and every 30 s, speed resolution (podcast override, then global default) and the sleep timer.
@MainActor @Observable
final class Player {
    // Published state
    private(set) var episode: Episode?
    private(set) var podcast: Podcast?
    private(set) var isPlaying = false
    private(set) var isBuffering = false
    private(set) var positionMs = 0
    private(set) var durationMs = 0
    private(set) var speed: Double = 1
    private(set) var speedIsOverride = false
    private(set) var sleep: SleepMode = .off
    private(set) var isFading = false
    private(set) var context: PlayContext = .upNext
    private(set) var error: String?
    private(set) var playingOffline = false

    var hasEpisode: Bool { episode != nil }
    var progress: Double { durationMs > 0 ? min(1, Double(positionMs) / Double(durationMs)) : 0 }

    static let skipBack = 15.0
    static let skipForward = 30.0
    private static let fadeSeconds = 10.0

    @ObservationIgnored weak var workspace: Workspace?
    @ObservationIgnored private let avPlayer = AVPlayer()
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var cancellables = Set<AnyCancellable>()
    @ObservationIgnored private var tick = 0
    @ObservationIgnored private var sleepTimer: Timer?
    @ObservationIgnored private var loadToken = 0
    @ObservationIgnored private let motion = CMMotionManager()
    @ObservationIgnored private var lastShake = Date.distantPast
    @ObservationIgnored private var remoteConfigured = false
    @ObservationIgnored private var artworkTask: Task<Void, Never>?
    @ObservationIgnored private var artworkImage: UIImage?
    /// True while the item plays a signed URL for the server's hosted copy (so an expired link can be renewed).
    @ObservationIgnored private var playingSigned = false
    @ObservationIgnored private var recovering = false
    @ObservationIgnored private var recoveries = 0
    @ObservationIgnored private var wantsPlay = false
    @ObservationIgnored private var itemObserver: AnyCancellable?

    init() {
        avPlayer.automaticallyWaitsToMinimizeStalling = true
        avPlayer.publisher(for: \.timeControlStatus).receive(on: DispatchQueue.main).sink { [weak self] s in self?.timeControlChanged(s) }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification).receive(on: DispatchQueue.main)
            .sink { [weak self] n in
                guard let self, (n.object as? AVPlayerItem) === self.avPlayer.currentItem else { return }
                Task { await self.onEnded() }
            }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification).receive(on: DispatchQueue.main)
            .sink { [weak self] n in self?.handleInterruption(n) }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification).receive(on: DispatchQueue.main)
            .sink { [weak self] n in
                if let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt, AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable { self?.pause() }
            }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification).receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.persist(syncSoon: true) }.store(in: &cancellables)
        timeObserver = avPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.onTick(t) }
        }
        sleepTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in Task { @MainActor in self?.tickSleep() } }
        configureRemoteCommands()
    }

    // MARK: loading

    /// Restore the last episode (paused) so the mini player shows after a relaunch.
    func restore() async {
        guard let ws = workspace, episode == nil, let id = ws.db.kv("player.episodeId") else { return }
        let ctx = ws.db.kvJSON("player.context", as: PlayContext.self) ?? .upNext
        await load(id, autoplay: false, context: ctx)
    }

    func play(_ episodeId: String, context: PlayContext? = nil) async {
        if context?.label == PlayContext.upNext.label { workspace?.data.enqueue(episodeId, .front) }
        await load(episodeId, autoplay: true, context: context)
    }

    /// Play a list: start at `episodeId`, then advance through `ids` before falling back to Up Next.
    func play(_ episodeId: String, in ids: [String], label: String) async {
        await load(episodeId, autoplay: true, context: PlayContext(label: label, ids: ids))
    }

    private func load(_ episodeId: String, autoplay: Bool, context ctx: PlayContext?) async {
        guard let ws = workspace else { return }
        loadToken += 1
        let token = loadToken
        persist(syncSoon: false)
        guard let ep = try? await ws.db.pool.read({ try Episode.fetchOne($0, key: episodeId) }) else { return }
        let pod = try? await ws.db.pool.read { try Podcast.fetchOne($0, key: ep.podcastId) }
        let st = ws.data.state(for: episodeId)
        let settings = ws.data.settings()
        let local = ws.downloads.fileURL(for: episodeId)
        guard token == loadToken else { return }
        // Not downloaded: stream the server's hosted copy through a signed URL when it has one.
        let hosted: URL? = local == nil ? await ws.api.signedStreamURL(for: episodeId) : nil
        guard token == loadToken else { return }

        let spd = SmartEvaluator.resolveSpeed(defaultSpeed: settings.defaultSpeed, podcastSpeeds: settings.podcastSpeeds, podcastId: ep.podcastId)
        let resumeMs = st.status == .played ? 0 : st.positionMs
        let newContext = ctx ?? context
        episode = ep; podcast = pod; speed = spd; speedIsOverride = settings.podcastSpeeds[ep.podcastId] != nil
        positionMs = resumeMs; durationMs = Int(ep.durationSec * 1000); context = newContext
        error = nil; playingOffline = local != nil; isBuffering = autoplay
        ws.db.setKV("player.episodeId", episodeId)
        ws.db.setKVJSON("player.context", newContext)

        guard let url = local ?? hosted ?? URL(string: ep.audioUrl) else { error = "This episode has no playable audio."; return }
        activateSession()
        playingSigned = local == nil && hosted != nil
        recoveries = 0
        wantsPlay = autoplay
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain // pitch-corrected speech at any speed (spec §3.3)
        avPlayer.replaceCurrentItem(with: item)
        watch(item, token: token)
        avPlayer.defaultRate = Float(spd)
        if resumeMs > 0 { await avPlayer.seek(to: CMTime(value: CMTimeValue(resumeMs), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) }
        loadArtwork(for: pod)
        updateNowPlaying()
        if autoplay {
            avPlayer.play()
            if st.status != .inProgress { ws.data.patchState(episodeId, positionUpdated: true, syncSoon: false) { $0.status = .inProgress; $0.positionMs = resumeMs } }
        }
        Task { await self.refineDuration(item, token: token) }
    }

    /// A signed link can expire mid-listen (or the hosted copy can be deleted): renew it and carry on from the same place.
    private func watch(_ item: AVPlayerItem, token: Int) {
        itemObserver = item.publisher(for: \.status).receive(on: DispatchQueue.main).sink { [weak self] status in
            guard let self, status == .failed, token == self.loadToken, self.playingSigned else { return }
            Task { await self.recoverStream(token: token) }
        }
    }

    private func recoverStream(token: Int) async {
        guard !recovering, let ep = episode, let ws = workspace else { return }
        recovering = true
        defer { recovering = false }
        let resume = positionMs
        recoveries += 1
        // After two failed renewals give up on the server's copy and use the podcast's own URL.
        let fresh: URL? = recoveries <= 2 ? await ws.api.signedStreamURL(for: ep.id) : nil
        guard token == loadToken, let url = fresh ?? URL(string: ep.audioUrl) else { return }
        playingSigned = fresh != nil
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain
        avPlayer.replaceCurrentItem(with: item)
        watch(item, token: token)
        if resume > 0 { await avPlayer.seek(to: CMTime(value: CMTimeValue(resume), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) }
        if wantsPlay { avPlayer.play(); avPlayer.rate = Float(speed) }
    }

    private func refineDuration(_ item: AVPlayerItem, token: Int) async {
        guard let d = try? await item.asset.load(.duration), d.isNumeric, d.seconds > 0, token == loadToken, let ep = episode, let ws = workspace else { return }
        durationMs = Int(d.seconds * 1000)
        // Feeds without (or with wrong) durations get the real value locally once the metadata loads.
        if abs(ep.durationSec - d.seconds) > 2 {
            var updated = ep
            updated.durationSec = d.seconds.rounded()
            episode = updated
            try? await ws.db.pool.write { try updated.update($0) }
        }
        updateNowPlaying()
    }

    private func activateSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
        try? s.setActive(true)
    }

    // MARK: state callbacks

    private func timeControlChanged(_ s: AVPlayer.TimeControlStatus) {
        let playing = s == .playing
        let buffering = s == .waitingToPlayAtSpecifiedRate && avPlayer.currentItem != nil
        if buffering != isBuffering { isBuffering = buffering }
        if playing != isPlaying {
            isPlaying = playing
            if !playing {
                persist(syncSoon: true)
                workspace?.sync.schedule(after: 0.3) // push on pause
            }
            updateNowPlaying()
        }
    }

    private func onTick(_ t: CMTime) {
        guard avPlayer.currentItem != nil, t.isNumeric else { return }
        positionMs = Int(t.seconds * 1000)
        tick += 1
        if isPlaying {
            if tick % 10 == 0 { persist(syncSoon: false) }               // every 5 s
            if tick % 60 == 0 { Task { await workspace?.sync.sync() } }  // every 30 s while online
            if tick % 4 == 0 { updateNowPlayingElapsed() }
        }
    }

    private func persist(syncSoon: Bool) {
        guard let ep = episode, let ws = workspace, avPlayer.currentItem != nil else { return }
        let pos = Int(avPlayer.currentTime().seconds * 1000)
        guard pos >= 0 else { return }
        ws.data.savePosition(ep.id, positionMs: pos, durationMs: durationMs)
        if syncSoon { ws.sync.schedule(after: 1.5) }
    }

    private func handleInterruption(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began { persist(syncSoon: true) }
        else if let o = n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt, AVAudioSession.InterruptionOptions(rawValue: o).contains(.shouldResume) { resume() }
    }

    // MARK: controls

    func toggle() { isPlaying ? pause() : resume() }
    func pause() { wantsPlay = false; avPlayer.pause() }
    func resume() {
        guard episode != nil else { return }
        wantsPlay = true
        activateSession()
        avPlayer.play()
        // `play()` starts at defaultRate; keep the resolved speed in force.
        avPlayer.rate = Float(speed)
    }

    func seek(toMs ms: Int) {
        let clamped = max(0, durationMs > 0 ? min(ms, durationMs) : ms)
        positionMs = clamped
        avPlayer.seek(to: CMTime(value: CMTimeValue(clamped), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.updateNowPlaying() }
        }
    }
    func skip(seconds: Double) { seek(toMs: positionMs + Int(seconds * 1000)) }
    func back() { skip(seconds: -Self.skipBack) }
    func forward() { skip(seconds: Self.skipForward) }

    /// Apply a speed to this podcast (override) or as the global default (spec §3.3).
    func setSpeed(_ value: Double, scope: SpeedScope) {
        guard let ws = workspace else { return }
        let s = LocalData.roundSpeed(value)
        if scope == .podcast, let p = podcast { ws.data.setPodcastSpeed(p.id, s) } else { ws.data.setDefaultSpeed(s) }
        refreshSpeed()
    }
    enum SpeedScope { case podcast, global }
    func clearSpeedOverride() {
        guard let p = podcast else { return }
        workspace?.data.setPodcastSpeed(p.id, nil)
        refreshSpeed()
    }
    /// Re-resolve speed (also after synced settings change).
    func refreshSpeed() {
        guard let ep = episode, let ws = workspace else { return }
        let st = ws.data.settings()
        speed = SmartEvaluator.resolveSpeed(defaultSpeed: st.defaultSpeed, podcastSpeeds: st.podcastSpeeds, podcastId: ep.podcastId)
        speedIsOverride = st.podcastSpeeds[ep.podcastId] != nil
        avPlayer.defaultRate = Float(speed)
        if isPlaying { avPlayer.rate = Float(speed) }
        updateNowPlaying()
    }

    func addBookmarkAtCurrent(title: String? = nil, note: String? = nil) {
        guard let ep = episode, let ws = workspace else { return }
        ws.data.addBookmark(episodeId: ep.id, positionMs: positionMs, title: title, note: note)
        Haptics.success()
    }

    // MARK: queue advancement

    private func onEnded() async {
        guard let ep = episode, let ws = workspace else { return }
        ws.data.markPlayed(ep.id)
        ws.data.dequeue(ep.id)
        ws.sync.schedule(after: 0.5)
        positionMs = 0
        if sleep == .endOfEpisode {
            sleep = .off; isFading = false; avPlayer.volume = 1
            return
        }
        var next: String?
        if let ids = context.ids, let i = ids.firstIndex(of: ep.id) { next = ids.dropFirst(i + 1).first }
        if next == nil { next = ws.data.queueIds().first }
        if let next {
            let ctx = context.ids?.contains(next) == true ? context : .upNext
            await load(next, autoplay: true, context: ctx)
        } else {
            isPlaying = false
            updateNowPlaying()
        }
    }

    func next() async {
        guard let ep = episode, let ws = workspace else { return }
        var next: String?
        if let ids = context.ids, let i = ids.firstIndex(of: ep.id), i + 1 < ids.count { next = ids[i + 1] }
        if next == nil { next = ws.data.queueIds().first { $0 != ep.id } }
        guard let next else { return }
        ws.data.dequeue(ep.id)
        await load(next, autoplay: true, context: context.ids?.contains(next) == true ? context : .upNext)
    }

    var hasNext: Bool {
        guard let ep = episode, let ws = workspace else { return false }
        if let ids = context.ids, let i = ids.firstIndex(of: ep.id), i + 1 < ids.count { return true }
        return ws.data.queueIds().contains { $0 != ep.id }
    }

    // MARK: sleep timer (spec §3.4; device-local, not synced)

    func setSleep(_ mode: SleepMode) {
        sleep = mode
        isFading = false
        avPlayer.volume = 1
        updateShakeDetection()
    }
    func setSleepTimer(minutes: Int) { setSleep(.timer(endsAt: Date().addingTimeInterval(Double(minutes) * 60))) }

    /// Extends on shake or tap: adds minutes to a running timer, or restarts one if it just ended/faded.
    func extendSleep(minutes: Int = 5) {
        switch sleep {
        case .timer(let end): setSleep(.timer(endsAt: max(end, Date()).addingTimeInterval(Double(minutes) * 60)))
        case .endOfEpisode: setSleep(.timer(endsAt: Date().addingTimeInterval(Double(minutes) * 60)))
        case .off: break
        }
        Haptics.success()
    }

    var sleepRemaining: TimeInterval? {
        switch sleep {
        case .off: return nil
        case .timer(let end): return max(0, end.timeIntervalSinceNow)
        case .endOfEpisode: return durationMs > 0 ? max(0, Double(durationMs - positionMs) / 1000 / max(speed, 0.1)) : nil
        }
    }

    private func tickSleep() {
        guard sleep != .off, isPlaying, let remaining = sleepRemaining else { return }
        if remaining <= 0, case .timer = sleep {
            wantsPlay = false; avPlayer.pause(); avPlayer.volume = 1
            sleep = .off; isFading = false
            updateShakeDetection()
        } else if remaining <= Self.fadeSeconds {
            avPlayer.volume = Float(max(0, remaining / Self.fadeSeconds)) // fade out the last 10 s
            if !isFading { isFading = true }
        } else if isFading {
            avPlayer.volume = 1; isFading = false
        }
    }

    private func updateShakeDetection() {
        if sleep != .off, motion.isAccelerometerAvailable, !motion.isAccelerometerActive {
            motion.accelerometerUpdateInterval = 0.1
            motion.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
                guard let self, let a = data?.acceleration, self.isFading else { return }
                let g = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
                if g > 2.3, Date().timeIntervalSince(self.lastShake) > 1.5 { self.lastShake = Date(); self.extendSleep(minutes: 5) }
            }
        } else if sleep == .off {
            motion.stopAccelerometerUpdates()
        }
    }

    // MARK: Now Playing + remote commands (lock screen, headset buttons, CarPlay)

    private func configureRemoteCommands() {
        guard !remoteConfigured else { return }
        remoteConfigured = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.resume(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.toggle(); return .success }
        c.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipForward)]
        c.skipForwardCommand.addTarget { [weak self] _ in self?.forward(); return .success }
        c.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipBack)]
        c.skipBackwardCommand.addTarget { [weak self] _ in self?.back(); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in Task { await self?.next() }; return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.back(); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(toMs: Int(e.positionTime * 1000)); return .success
        }
        c.changePlaybackRateCommand.supportedPlaybackRates = stride(from: 0.5, through: 3.0, by: 0.1).map { NSNumber(value: ($0 * 10).rounded() / 10) }
        c.changePlaybackRateCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            self?.setSpeed(Double(e.playbackRate), scope: .podcast); return .success
        }
    }

    private func loadArtwork(for pod: Podcast?) {
        artworkTask?.cancel()
        artworkImage = nil
        guard let s = pod?.imageUrl, let url = URL(string: s) else { return }
        artworkTask = Task { [weak self] in
            let img = await ImageCache.shared.image(for: url)
            guard !Task.isCancelled, let self else { return }
            self.artworkImage = img
            self.updateNowPlaying()
        }
    }

    private func updateNowPlaying() {
        guard let ep = episode else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: ep.title,
            MPMediaItemPropertyArtist: podcast?.title ?? "",
            MPMediaItemPropertyAlbumTitle: podcast?.title ?? "",
            MPMediaItemPropertyPlaybackDuration: Double(durationMs) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(positionMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? speed : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: speed,
            MPMediaItemPropertyMediaType: MPMediaType.podcast.rawValue,
        ]
        if let img = artworkImage { info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img } }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }
    private func updateNowPlayingElapsed() {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = Double(positionMs) / 1000
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
