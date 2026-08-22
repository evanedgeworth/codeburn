import Foundation
import Testing

// Keep the old assertion spellings while the remaining XCTest suites migrate
// to Swift Testing. This host's standalone Command Line Tools omit XCTest.
func XCTAssertEqual<T: Equatable>(
    _ actual: T,
    _ expected: T,
    _ message: String = "",
    sourceLocation: SourceLocation = #_sourceLocation
) {
    guard actual != expected else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected \(actual) to equal \(expected)" : message), sourceLocation: sourceLocation)
}

func XCTAssertEqual(
    _ actual: Double,
    _ expected: Double,
    accuracy: Double,
    _ message: String = "",
    sourceLocation: SourceLocation = #_sourceLocation
) {
    guard abs(actual - expected) > accuracy else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected \(actual) to equal \(expected) within \(accuracy)" : message), sourceLocation: sourceLocation)
}

func XCTAssertTrue(_ value: Bool, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard !value else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected true" : message), sourceLocation: sourceLocation)
}

func XCTAssertFalse(_ value: Bool, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard value else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected false" : message), sourceLocation: sourceLocation)
}

func XCTAssertNil<T>(_ value: T?, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard value != nil else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected nil" : message), sourceLocation: sourceLocation)
}

func XCTAssertNotNil<T>(_ value: T?, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard value == nil else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected a non-nil value" : message), sourceLocation: sourceLocation)
}

func XCTAssertNotEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard actual == expected else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected unequal values" : message), sourceLocation: sourceLocation)
}

func XCTAssertLessThan<T: Comparable>(_ actual: T, _ expected: T, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard !(actual < expected) else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected \(actual) to be less than \(expected)" : message), sourceLocation: sourceLocation)
}

func XCTAssertLessThanOrEqual<T: Comparable>(_ actual: T, _ expected: T, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) {
    guard !(actual <= expected) else { return }
    Issue.record(Comment(rawValue: message.isEmpty ? "Expected \(actual) to be at most \(expected)" : message), sourceLocation: sourceLocation)
}

func XCTAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, sourceLocation: SourceLocation = #_sourceLocation) {
    do {
        _ = try expression()
        Issue.record("Expected expression to throw", sourceLocation: sourceLocation)
    } catch {
        // Expected.
    }
}

func XCTUnwrap<T>(_ value: T?, _ message: String = "", sourceLocation: SourceLocation = #_sourceLocation) throws -> T {
    guard let value else {
        Issue.record(Comment(rawValue: message.isEmpty ? "Expected a non-nil value" : message), sourceLocation: sourceLocation)
        throw UnwrapFailure()
    }
    return value
}

private struct UnwrapFailure: Error {}
