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
