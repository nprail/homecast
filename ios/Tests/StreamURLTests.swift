import XCTest
@testable import Homecast

/// `APIClient.signedStreamURL` (episode hosting): the signed URL the server returns is resolved against the configured server,
/// and every failure mode (not hosted, HTTP error, unreachable, too slow) yields nil so playback uses the podcast's own URL.
final class StreamURLTests: XCTestCase {
    /// Answers every request with whatever `handler` returns; `nil` never answers (a hung server).
    final class Stub: URLProtocol {
        nonisolated(unsafe) static var handler: ((URLRequest) -> Result<(Int, Data), URLError>?)?
        nonisolated(unsafe) static var lastRequest: URLRequest?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Stub.lastRequest = request
            guard let result = Stub.handler?(request) else { return } // hang
            switch result {
            case .failure(let e): client?.urlProtocol(self, didFailWithError: e)
            case .success(let (status, data)):
                let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
                client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        override func stopLoading() {}
    }

    private func client() -> APIClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [Stub.self]
        return APIClient(baseURL: URL(string: "http://hc.test:8080")!, configuration: cfg)
    }

    override func tearDown() { Stub.handler = nil; Stub.lastRequest = nil }

    func testResolvesTheSignedURLAgainstTheServer() async {
        Stub.handler = { _ in .success((200, Data(#"{"url":"/api/v1/media/ep1?u=user&exp=123&sig=abc","expiresAt":123}"#.utf8))) }
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertEqual(url?.absoluteString, "http://hc.test:8080/api/v1/media/ep1?u=user&exp=123&sig=abc")
        XCTAssertEqual(Stub.lastRequest?.url?.path, "/api/v1/episodes/ep1/stream")
    }

    func testNotHostedMeansNoURL() async {
        Stub.handler = { _ in .success((200, Data(#"{"url":null,"expiresAt":null}"#.utf8))) }
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertNil(url)
    }

    func testServerErrorsMeanNoURL() async {
        Stub.handler = { _ in .success((404, Data(#"{"error":{"code":"not_found","message":"Episode not found"}}"#.utf8))) }
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertNil(url)
    }

    func testGarbageMeansNoURL() async {
        Stub.handler = { _ in .success((200, Data("<html>proxy error</html>".utf8))) }
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertNil(url)
    }

    func testUnreachableServerMeansNoURL() async {
        Stub.handler = { _ in .failure(URLError(.cannotConnectToHost)) }
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertNil(url)
    }

    func testASlowServerIsGivenUpOnQuickly() async {
        Stub.handler = { _ in nil } // never answers
        let started = Date()
        let url = await client().signedStreamURL(for: "ep1")
        XCTAssertNil(url)
        XCTAssertLessThan(Date().timeIntervalSince(started), 8, "should give up after about four seconds")
    }
}
