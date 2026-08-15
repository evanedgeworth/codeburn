import Foundation

enum BillingConfidence: String, Sendable, Equatable {
    case vendorReconciled
    case authDetected
    case explicitSetting
    case localEstimate

    var label: String {
        switch self {
        case .vendorReconciled: "Vendor reconciled"
        case .authDetected: "Login mode detected"
        case .explicitSetting: "Coverage set manually"
        case .localEstimate: "Local estimate"
        }
    }
}

struct BillingDailyEntry: Identifiable, Sendable, Equatable {
    var id: String { date }
    let date: String
    let apiEquivalentUSD: Double
    let subscriptionCoveredUSD: Double
    let estimatedBillableUSD: Double
    let unknownAttributionUSD: Double
}

struct MembershipPlan: Sendable, Equatable {
    let provider: BillingProvider
    let monthlyUSD: Double
}

struct MembershipValueSummary: Sendable, Equatable {
    let monthlyMembershipUSD: Double
    let monthToDateAPIEquivalentUSD: Double

    var equivalentValueRatio: Double? {
        guard monthlyMembershipUSD > 0 else { return nil }
        return monthToDateAPIEquivalentUSD / monthlyMembershipUSD
    }
}

struct BillingTruth: Sendable, Equatable {
    let breakdown: BillingCostBreakdown
    /// Organization invoice cost for the current billing month. Deliberately
    /// separate from the selected local period so "Today" can never display a
    /// month-to-date number as if it covered only today.
    let reconciledMonthToDateUSD: Double?
    let reconciliationFetchedAt: Date?
    let confidence: BillingConfidence

    var isReconciled: Bool { reconciledMonthToDateUSD != nil }
}

struct BillingAlert: Identifiable, Sendable, Equatable {
    enum Severity: Sendable, Equatable {
        case warning
        case danger
    }

    var id: String { "\(severity)-\(message)" }
    let severity: Severity
    let message: String
}

enum BillingCoveragePreferences {
    static func defaultsKey(for provider: BillingProvider) -> String {
        "CodeBurnBillingCoverageMode.\(provider.rawValue)"
    }

    static func load(provider: BillingProvider, defaults: UserDefaults = .standard) -> BillingCoverageMode {
        if let raw = defaults.string(forKey: defaultsKey(for: provider)),
           let mode = BillingCoverageMode(rawValue: raw)
        {
            return mode
        }
        return .automatic
    }

    static func save(_ mode: BillingCoverageMode, provider: BillingProvider, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: defaultsKey(for: provider))
    }
}

enum BillingModeDetector {
    static func policy(provider: BillingProvider, mode: BillingCoverageMode) -> BillingProviderPolicy {
        let automatic = detect(provider)
        let reason: String
        switch mode {
        case .automatic: reason = automatic.reason
        case .covered: reason = "Marked subscription-covered"
        case .billable: reason = "Marked billable / API key"
        }
        return BillingProviderPolicy(mode: mode, automaticResolution: automatic.resolution, reason: reason)
    }

    static func detect(_ provider: BillingProvider) -> (resolution: BillingResolution, reason: String) {
        switch provider {
        case .codex: return detectCodex()
        case .claude: return detectClaude()
        case .cursor:
            return (.unknown, "Cursor does not expose personal billing mode in local logs")
        }
    }

    private static func detectCodex() -> (BillingResolution, String) {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/auth.json")
        guard let data = try? SafeFile.read(from: url.path, maxBytes: 64 * 1024),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = root["auth_mode"] as? String
        else { return (.unknown, "Codex login mode unavailable") }
        if mode == "chatgpt" { return (.covered, "ChatGPT subscription login detected") }
        if mode == "apikey" || mode == "api_key" { return (.billable, "Codex API-key login detected") }
        return (.unknown, "Unrecognized Codex login mode")
    }

    private static func detectClaude() -> (BillingResolution, String) {
        let env = ProcessInfo.processInfo.environment
        if ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]
            .contains(where: { !(env[$0] ?? "").isEmpty })
        {
            return (.billable, "Claude API or cloud-provider credentials detected")
        }
        if claudeSettingsDeclareBillableCredentials() {
            return (.billable, "Claude settings declare API or cloud-provider credentials")
        }
        if ClaudeCredentialStore.isBootstrapCompleted {
            return (.covered, "Claude subscription login connected")
        }
        let credentials = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/.credentials.json")
        if FileManager.default.fileExists(atPath: credentials.path) {
            return (.covered, "Claude OAuth credentials detected")
        }
        return (.unknown, "Claude billing mode unavailable")
    }

    private static func claudeSettingsDeclareBillableCredentials() -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let paths = [".claude/settings.json", ".claude/settings.local.json"]
        let billableKeys = Set([
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
        ])
        for path in paths {
            let url = home.appendingPathComponent(path)
            guard let data = try? SafeFile.read(from: url.path, maxBytes: 256 * 1024),
                  let object = try? JSONSerialization.jsonObject(with: data)
            else { continue }
            if containsAnyKey(object, keys: billableKeys) { return true }
        }
        return false
    }

    private static func containsAnyKey(_ value: Any, keys: Set<String>) -> Bool {
        if let object = value as? [String: Any] {
            if object.keys.contains(where: keys.contains) { return true }
            return object.values.contains { containsAnyKey($0, keys: keys) }
        }
        if let array = value as? [Any] {
            return array.contains { containsAnyKey($0, keys: keys) }
        }
        return false
    }
}

enum MembershipPlanStore {
    static func load() -> [BillingProvider: MembershipPlan] {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/codeburn/config.json")
        guard let data = try? SafeFile.read(from: url.path, maxBytes: 512 * 1024),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawPlans = root["plans"] as? [String: Any]
        else { return [:] }

        var result: [BillingProvider: MembershipPlan] = [:]
        for provider in BillingProvider.allCases {
            guard let raw = rawPlans[provider.rawValue] as? [String: Any],
                  let monthly = raw["monthlyUsd"] as? NSNumber,
                  monthly.doubleValue > 0
            else { continue }
            result[provider] = MembershipPlan(provider: provider, monthlyUSD: monthly.doubleValue)
        }
        return result
    }
}

enum BillingHistoryCalculator {
    static func entries(
        _ history: [DailyHistoryEntry],
        policies: [BillingProvider: BillingProviderPolicy]
    ) -> [BillingDailyEntry] {
        history.map { day in
            let providers = day.providers.isEmpty ? ["unattributed": day.cost] : day.providers
            let breakdown = BillingCostCalculator.breakdown(
                apiEquivalentUSD: day.cost,
                providerCosts: providers,
                policies: policies
            )
            return BillingDailyEntry(
                date: day.date,
                apiEquivalentUSD: breakdown.apiEquivalentUSD,
                subscriptionCoveredUSD: breakdown.subscriptionCoveredUSD,
                estimatedBillableUSD: breakdown.estimatedBillableUSD,
                unknownAttributionUSD: breakdown.unknownAttributionUSD
            )
        }
    }

    static func membershipValue(
        history: [DailyHistoryEntry],
        plans: [BillingProvider: MembershipPlan],
        now: Date = Date()
    ) -> MembershipValueSummary {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let components = calendar.dateComponents([.year, .month], from: now)
        let monthStart = calendar.date(from: components) ?? now
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        let start = formatter.string(from: monthStart)
        let coveredProviders = Set(plans.keys)
        let apiEquivalent = history.filter { $0.date >= start }.reduce(0.0) { total, day in
            total + day.providers.reduce(0.0) { providerTotal, entry in
                guard let provider = BillingProvider.classify(entry.key), coveredProviders.contains(provider) else {
                    return providerTotal
                }
                return providerTotal + max(0, entry.value)
            }
        }
        return MembershipValueSummary(
            monthlyMembershipUSD: plans.values.reduce(0) { $0 + $1.monthlyUSD },
            monthToDateAPIEquivalentUSD: apiEquivalent
        )
    }
}
