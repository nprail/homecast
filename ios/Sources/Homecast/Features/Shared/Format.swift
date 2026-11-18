import SwiftUI
import Foundation

enum Fmt {
    /// "1 hr 4 min", "37 min", "3 min".
    static func duration(_ sec: Double) -> String {
        let m = Int((sec / 60).rounded())
        if m <= 0 { return sec > 0 ? "<1 min" : "" }
        if m < 60 { return "\(m) min" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h) hr" : "\(h) hr \(r) min"
    }
    /// Clock for scrubbers: 3:07 or 1:03:07.
    static func clock(_ ms: Int) -> String {
        let s = max(0, ms / 1000)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
    static func speed(_ s: Double) -> String {
        let r = (s * 10).rounded() / 10
        return (r == r.rounded() ? String(format: "%.0f", r) : String(format: "%.1f", r)) + "×"
    }
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .short; return f
    }()
    private static let short: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f
    }()
    static func released(_ date: Date) -> String {
        let days = Calendar.current.dateComponents([.day], from: date, to: Date()).day ?? 0
        if days < 1 { return "Today" }
        if days < 7 { return relative.localizedString(for: date, relativeTo: Date()) }
        return short.string(from: date)
    }
    static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
    static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
    static func sleepRemaining(_ s: TimeInterval) -> String {
        let t = Int(s.rounded(.up))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
    /// Strips HTML from feed descriptions to plain text (spec §7: feed HTML is never rendered raw).
    static func plainText(_ html: String) -> String {
        var s = html.replacingOccurrences(of: "<br\\s*/?>|</p>|</li>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (k, v) in ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " ", "&apos;": "'"] { s = s.replacingOccurrences(of: k, with: v) }
        return s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A shareable "moment": a link that opens an episode in this server's web player, at a time if one is given.
@MainActor
enum Moment {
    /// `https://your-server/episode/ID?t=SECONDS`. nil only if the saved server address is unusable.
    static func url(episodeId: String, positionMs: Int? = nil) -> URL? {
        let base = AppEnvironment.shared.serverURLString.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !base.isEmpty else { return nil }
        let t = (positionMs ?? 0) >= 1000 ? "?t=\((positionMs ?? 0) / 1000)" : ""
        return URL(string: "\(base)/episode/\(episodeId)\(t)")
    }

    /// The words that go with the link: a quote if there is one, then where it is from.
    static func message(title: String, podcast: String?, positionMs: Int? = nil, quote: String? = nil) -> String {
        let at = (positionMs ?? 0) >= 1000 ? " (\(Fmt.clock(positionMs ?? 0)))" : ""
        let from = title + (podcast.map { ", \($0)" } ?? "") + at
        if let q = quote?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty { return "\u{201C}\(q.prefix(280))\u{201D} \u{2014} \(from)" }
        return from
    }
}

/// Share sheet button for an episode, optionally at a moment and with a quoted transcript line.
struct ShareMomentLink<Label: View>: View {
    let episodeId: String
    let title: String
    var podcast: String?
    var positionMs: Int?
    var quote: String?
    @ViewBuilder var label: () -> Label

    var body: some View {
        if let url = Moment.url(episodeId: episodeId, positionMs: positionMs) {
            ShareLink(item: url, subject: Text(title), message: Text(Moment.message(title: title, podcast: podcast, positionMs: positionMs, quote: quote))) { label() }
        }
    }
}

/// A piece of show notes: plain text, a link, or a timestamp that jumps in the episode.
enum NoteSegment: Equatable {
    case text(String)
    case link(text: String, url: String)
    case time(text: String, ms: Int)
}

/// Finds links and timestamps in show notes. Same rules as `shared/src/showNotes.ts`
/// (vectors: shared/vectors/show-notes.json).
enum ShowNotes {
    /// A web address, or a timestamp ([h:]m:ss) that is not part of a longer word or number and not a time of day.
    private static let token = try! NSRegularExpression(pattern: #"(?:https?://|www\.)[^\s<>"']+|(?<![A-Za-z0-9_:/.])(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?![A-Za-z0-9_:])(?!\s?[AaPp]\.?[Mm])"#)
    private static let anchor = try! NSRegularExpression(pattern: #"<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)</a>"#, options: .caseInsensitive)

    private static func trimUrl(_ raw: String) -> String {
        var u = raw
        func count(_ c: Character) -> Int { u.filter { $0 == c }.count }
        while let last = u.last {
            if ".,;:!?'\"".contains(last) { u.removeLast() }
            else if last == ")" && count("(") < count(")") { u.removeLast() }
            else if last == "]" && count("[") < count("]") { u.removeLast() }
            else { break }
        }
        return u
    }

    /// Splits plain text into text, link and timestamp segments. Timestamps past `durationMs` (when known) stay text.
    static func linkify(_ text: String, durationMs: Int = 0) -> [NoteSegment] {
        var out: [NoteSegment] = []
        func push(_ s: NoteSegment) {
            if case .text(let t) = s {
                if t.isEmpty { return }
                if case .text(let p)? = out.last { out[out.count - 1] = .text(p + t); return }
            }
            out.append(s)
        }
        let ns = text as NSString
        var last = 0
        for m in token.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var raw = ns.substring(with: m.range)
            let seg: NoteSegment
            if m.range(at: 2).location == NSNotFound {
                raw = trimUrl(raw)
                if raw.utf16.count < 8 { continue }
                seg = .link(text: raw, url: raw.hasPrefix("www.") ? "https://" + raw : raw)
            } else {
                func part(_ i: Int) -> Int { m.range(at: i).location == NSNotFound ? 0 : Int(ns.substring(with: m.range(at: i))) ?? 0 }
                let ms = ((part(1) * 60 + part(2)) * 60 + part(3)) * 1000
                if durationMs > 0 && ms > durationMs { continue }
                seg = .time(text: raw, ms: ms)
            }
            push(.text(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            push(seg)
            last = m.range.location + raw.utf16.count
        }
        push(.text(ns.substring(from: last)))
        return out
    }

    private static func plain(_ html: String) -> String {
        var s = html.replacingOccurrences(of: "<br\\s*/?>|</p>|</li>", with: "\n", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (k, v) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " "), ("&amp;", "&")] { s = s.replacingOccurrences(of: k, with: v) }
        return s.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    }

    /// Show notes HTML to segments: tags dropped, `<a href>` (http, https, mailto) kept as links, bare URLs and timestamps found.
    static func parse(_ html: String, durationMs: Int = 0) -> [NoteSegment] {
        var out: [NoteSegment] = []
        func add(_ segs: [NoteSegment]) {
            for s in segs {
                if case .text(let t) = s, case .text(let p)? = out.last { out[out.count - 1] = .text(p + t) } else { out.append(s) }
            }
        }
        let ns = html as NSString
        var last = 0
        for m in anchor.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            add(linkify(plain(ns.substring(with: NSRange(location: last, length: m.range.location - last))), durationMs: durationMs))
            func group(_ i: Int) -> String? { m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
            let url = plain(group(1) ?? group(2) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let label = plain(group(3) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let scheme = url.lowercased()
            if scheme.hasPrefix("http:") || scheme.hasPrefix("https:") || scheme.hasPrefix("mailto:") {
                add([.link(text: label.isEmpty ? url : label, url: url)])
            } else {
                add(linkify(label, durationMs: durationMs))
            }
            last = m.range.location + m.range.length
        }
        add(linkify(plain(ns.substring(from: last)), durationMs: durationMs))
        if case .text(let t)? = out.first { out[0] = .text(String(t.drop { $0.isWhitespace })) }
        if case .text(let t)? = out.last { out[out.count - 1] = .text(String(t.reversed().drop { $0.isWhitespace }.reversed())) }
        return out.filter { if case .text(let t) = $0 { return !t.isEmpty }; return true }
    }

    static let seekScheme = "homecast-seek"

    /// The notes as styled text. Links open normally; a timestamp is a `homecast-seek://MS` link for `OpenURLAction`.
    static func attributed(_ segments: [NoteSegment]) -> AttributedString {
        var out = AttributedString()
        for s in segments {
            switch s {
            case .text(let t): out += AttributedString(t)
            case .link(let t, let u):
                var a = AttributedString(t)
                a.link = URL(string: u)
                out += a
            case .time(let t, let ms):
                var a = AttributedString(t)
                a.link = URL(string: "\(seekScheme)://\(ms)")
                a.font = .system(size: 16, weight: .semibold).monospacedDigit()
                out += a
            }
        }
        return out
    }

    /// The milliseconds in a timestamp link made by `attributed`, or nil for any other URL.
    static func seekTarget(_ url: URL) -> Int? {
        url.scheme == seekScheme ? Int(url.host ?? "") : nil
    }
}
