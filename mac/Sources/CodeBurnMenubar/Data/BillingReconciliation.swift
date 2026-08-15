import Foundation
import Security

struct VendorBillingSnapshot: Codable, Sendable, Equatable {
    let provider: BillingProvider
    let dailyUSD: [String: Double]
    let monthToDateUSD: Double?
    let periodStart: Date
    let periodEnd: Date
    let fetchedAt: Date

    var isStale: Bool { Date().timeIntervalSince(fetchedAt) > 6 * 60 * 60 }

    func cost(from startDate: String, through endDate: String) -> Double {
        dailyUSD.reduce(0) { total, entry in
            guard entry.key >= startDate, entry.key <= endDate else { return total }
            return total + entry.value
        }
    }
}

enum BillingSyncState: Sendable, Equatable {
    case disconnected
    case idle
    case syncing
    case synced(Date)
    case failed(String)

    var isConnected: Bool {
        switch self {
        case .disconnected: false
        case .idle, .syncing, .synced, .failed: true
        }
    }
}

enum BillingCredentialStore {
    private static let service = "org.agentseal.codeburn.billing-reconciliation"

    enum StoreError: Error, LocalizedError {
        case emptyCredential
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .emptyCredential: "Credential cannot be empty."
            case let .keychain(status): "Keychain operation failed (status \(status))."
            }
        }
    }

    static func save(_ credential: String, for provider: BillingProvider) throws {
        let trimmed = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw StoreError.emptyCredential }
        let data = Data(trimmed.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw StoreError.keychain(update) }
        var add = query
        attributes.forEach { add[$0.key] = $0.value }
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
    }

    static func read(for provider: BillingProvider) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let credential = String(data: data, encoding: .utf8), !credential.isEmpty
        else { throw StoreError.keychain(status) }
        return credential
    }

    static func containsCredential(for provider: BillingProvider) -> Bool {
        (try? read(for: provider)) != nil
    }

    static func delete(for provider: BillingProvider) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.keychain(status)
        }
    }
}

actor BillingSnapshotStore {
    static let shared = BillingSnapshotStore()
    private let filename = "billing-reconciliation.v1.json"

    func load() -> [BillingProvider: VendorBillingSnapshot] {
        guard let data = try? SafeFile.read(from: fileURL().path, maxBytes: 2 * 1024 * 1024) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let snapshots = try? decoder.decode([VendorBillingSnapshot].self, from: data) else { return [:] }
        return Dictionary(uniqueKeysWithValues: snapshots.map { ($0.provider, $0) })
    }

    func save(_ snapshots: [BillingProvider: VendorBillingSnapshot]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(snapshots.values.sorted { $0.provider.rawValue < $1.provider.rawValue }) else { return }
        let url = fileURL()
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    func remove(provider: BillingProvider, from snapshots: [BillingProvider: VendorBillingSnapshot]) {
        var next = snapshots
        next.removeValue(forKey: provider)
        save(next)
    }

    private func fileURL() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("CodeBurn", isDirectory: true).appendingPathComponent(filename)
    }
}

actor BillingReconciliationService {
    static let shared = BillingReconciliationService()
    private let maxPages = 50
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        session = URLSession(configuration: configuration)
    }

    enum ServiceError: Error, LocalizedError {
        case invalidURL
        case http(Int, String)
        case malformedResponse
        case tooManyPages

        var errorDescription: String? {
            switch self {
            case .invalidURL: "Billing endpoint URL could not be built."
            case let .http(code, message): "Billing API returned HTTP \(code)\(message.isEmpty ? "" : ": \(message)")"
            case .malformedResponse: "Billing API returned an unexpected response."
            case .tooManyPages: "Billing API pagination exceeded the safety limit."
            }
        }
    }

    func fetch(
        provider: BillingProvider,
        credential: String,
        start: Date,
        end: Date
    ) async throws -> VendorBillingSnapshot {
        switch provider {
        case .codex: return try await fetchOpenAI(credential: credential, start: start, end: end)
        case .claude: return try await fetchAnthropic(credential: credential, start: start, end: end)
        case .cursor: return try await fetchCursor(credential: credential, start: start, end: end)
        }
    }

    private func fetchOpenAI(credential: String, start: Date, end: Date) async throws -> VendorBillingSnapshot {
        var page: String?
        var daily: [String: Double] = [:]
        for index in 0..<maxPages {
            var components = URLComponents(string: "https://api.openai.com/v1/organization/costs")
            components?.queryItems = [
                URLQueryItem(name: "start_time", value: String(Int(start.timeIntervalSince1970))),
                URLQueryItem(name: "end_time", value: String(Int(end.timeIntervalSince1970))),
                URLQueryItem(name: "bucket_width", value: "1d"),
                URLQueryItem(name: "limit", value: "180"),
            ] + (page.map { [URLQueryItem(name: "page", value: $0)] } ?? [])
            guard let url = components?.url else { throw ServiceError.invalidURL }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let object = try await json(request)
            guard let data = object["data"] as? [[String: Any]] else { throw ServiceError.malformedResponse }
            for bucket in data {
                guard let stamp = number(bucket["start_time"]) else { continue }
                let date = dateKey(Date(timeIntervalSince1970: stamp))
                let results = bucket["results"] as? [[String: Any]] ?? []
                let amount = results.reduce(0.0) { total, row in
                    guard let value = (row["amount"] as? [String: Any]).flatMap({ number($0["value"]) }) else { return total }
                    return total + value
                }
                daily[date, default: 0] += amount
            }
            let hasMore = object["has_more"] as? Bool ?? false
            page = object["next_page"] as? String
            if !hasMore { break }
            guard page != nil else { throw ServiceError.malformedResponse }
            if index == maxPages - 1 { throw ServiceError.tooManyPages }
        }
        return snapshot(provider: .codex, daily: daily, start: start, end: end)
    }

    private func fetchAnthropic(credential: String, start: Date, end: Date) async throws -> VendorBillingSnapshot {
        var page: String?
        var daily: [String: Double] = [:]
        let iso = ISO8601DateFormatter()
        for index in 0..<maxPages {
            var components = URLComponents(string: "https://api.anthropic.com/v1/organizations/cost_report")
            components?.queryItems = [
                URLQueryItem(name: "starting_at", value: iso.string(from: start)),
                URLQueryItem(name: "ending_at", value: iso.string(from: end)),
                URLQueryItem(name: "bucket_width", value: "1d"),
                URLQueryItem(name: "limit", value: "31"),
            ] + (page.map { [URLQueryItem(name: "page", value: $0)] } ?? [])
            guard let url = components?.url else { throw ServiceError.invalidURL }
            var request = URLRequest(url: url)
            request.setValue(credential, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let object = try await json(request)
            guard let data = object["data"] as? [[String: Any]] else { throw ServiceError.malformedResponse }
            for bucket in data {
                guard let rawDate = bucket["starting_at"] as? String,
                      let parsed = iso.date(from: rawDate)
                else { continue }
                let results = bucket["results"] as? [[String: Any]] ?? []
                // Anthropic reports decimal strings in the lowest currency unit
                // (cents), so divide the summed amount by 100 for USD.
                let cents = results.reduce(0.0) { $0 + (number($1["amount"]) ?? 0) }
                daily[dateKey(parsed), default: 0] += cents / 100
            }
            let hasMore = object["has_more"] as? Bool ?? false
            page = object["next_page"] as? String
            if !hasMore { break }
            guard page != nil else { throw ServiceError.malformedResponse }
            if index == maxPages - 1 { throw ServiceError.tooManyPages }
        }
        return snapshot(provider: .claude, daily: daily, start: start, end: end)
    }

    private func fetchCursor(credential: String, start: Date, end: Date) async throws -> VendorBillingSnapshot {
        var daily: [String: Double] = [:]
        // Cursor has varied this endpoint's maximum date range. Chunking into
        // 30-day requests works across both the old 30-day and newer 90-day
        // limits while still retaining the app's longer local history.
        var chunkStart = start
        while chunkStart < end {
            let chunkEnd = min(end, chunkStart.addingTimeInterval(30 * 86_400))
            var page = 1
            while page <= maxPages {
                guard let url = URL(string: "https://api.cursor.com/teams/filtered-usage-events") else {
                    throw ServiceError.invalidURL
                }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                let basic = Data("\(credential):".utf8).base64EncodedString()
                request.setValue("Basic \(basic)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "startDate": Int(chunkStart.timeIntervalSince1970 * 1000),
                    "endDate": Int(chunkEnd.timeIntervalSince1970 * 1000),
                    "page": page,
                    "pageSize": 100,
                ])
                let object = try await json(request)
                let events = (object["usageEvents"] as? [[String: Any]])
                    ?? (object["usageEventsDisplay"] as? [[String: Any]])
                    ?? []
                for event in events {
                    guard cursorEventIsBillable(event),
                          let date = cursorEventDate(event["timestamp"])
                    else { continue }
                    let cents = (event["tokenUsage"] as? [String: Any]).flatMap { number($0["totalCents"]) } ?? 0
                    daily[dateKey(date), default: 0] += cents / 100
                }
                let pagination = object["pagination"] as? [String: Any]
                let hasNext = pagination?["hasNextPage"] as? Bool ?? false
                if !hasNext { break }
                page += 1
            }
            if page > maxPages { throw ServiceError.tooManyPages }
            chunkStart = chunkEnd
        }
        let monthTotal = try? await fetchCursorMonthSpend(credential: credential)
        return VendorBillingSnapshot(
            provider: .cursor,
            dailyUSD: daily,
            monthToDateUSD: monthTotal,
            periodStart: start,
            periodEnd: end,
            fetchedAt: Date()
        )
    }

    private func fetchCursorMonthSpend(credential: String) async throws -> Double {
        guard let url = URL(string: "https://api.cursor.com/teams/spend") else { throw ServiceError.invalidURL }
        let basic = Data("\(credential):".utf8).base64EncodedString()
        var totalCents = 0.0
        var page = 1
        while page <= maxPages {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Basic \(basic)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["page": page, "pageSize": 100])
            let object = try await json(request)
            let rows = object["teamMemberSpend"] as? [[String: Any]] ?? []
            totalCents += rows.reduce(0.0) { $0 + (number($1["spendCents"]) ?? 0) }
            let totalPages = Int(number(object["totalPages"]) ?? 1)
            if page >= totalPages { return totalCents / 100 }
            page += 1
        }
        throw ServiceError.tooManyPages
    }

    private func cursorEventIsBillable(_ event: [String: Any]) -> Bool {
        guard let raw = event["kind"] as? String else { return false }
        let normalized = raw.lowercased().replacingOccurrences(of: "_", with: "-")
        return normalized.contains("usage") && normalized.contains("based")
    }

    private func json(_ request: URLRequest) async throws -> [String: Any] {
        var request = request
        request.setValue("CodeBurn billing reconciliation", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ServiceError.malformedResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(decoding: data.prefix(512), as: UTF8.self)
                .replacingOccurrences(of: "\n", with: " ")
            throw ServiceError.http(http.statusCode, body)
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ServiceError.malformedResponse
        }
        return object
    }

    private func snapshot(provider: BillingProvider, daily: [String: Double], start: Date, end: Date) -> VendorBillingSnapshot {
        let monthStart = Calendar(identifier: .gregorian).date(from: Calendar.current.dateComponents([.year, .month], from: Date()))
        let monthKey = monthStart.map(dateKey) ?? ""
        let monthTotal = daily.filter { $0.key >= monthKey }.reduce(0) { $0 + $1.value }
        return VendorBillingSnapshot(
            provider: provider,
            dailyUSD: daily,
            monthToDateUSD: monthTotal,
            periodStart: start,
            periodEnd: end,
            fetchedAt: Date()
        )
    }

    private func cursorEventDate(_ value: Any?) -> Date? {
        if let number = number(value) {
            return Date(timeIntervalSince1970: number > 10_000_000_000 ? number / 1000 : number)
        }
        guard let raw = value as? String else { return nil }
        if let number = Double(raw) {
            return Date(timeIntervalSince1970: number > 10_000_000_000 ? number / 1000 : number)
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }

    private func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private func dateKey(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
