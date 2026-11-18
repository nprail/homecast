import XCTest
@testable import Homecast

/// Runs the shared show-notes vectors (shared/vectors/show-notes.json): same segments as the TypeScript parser.
final class ShowNotesTests: XCTestCase {
    func testSharedVectors() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "show-notes", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 8)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let expected: [NoteSegment] = (c["expected"] as? [[String: Any]] ?? []).map { e in
                switch e["type"] as? String {
                case "link": return .link(text: e["text"] as? String ?? "", url: e["url"] as? String ?? "")
                case "time": return .time(text: e["text"] as? String ?? "", ms: e["ms"] as? Int ?? -1)
                default: return .text(e["text"] as? String ?? "")
                }
            }
            XCTAssertEqual(ShowNotes.parse(c["html"] as? String ?? "", durationMs: c["durationMs"] as? Int ?? 0), expected, name)
        }
    }
}
