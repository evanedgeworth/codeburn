import Foundation

/// Coarse provider families used for local billing attribution. CodeBurn's
/// session logs expose token usage and API-rate value, but not whether a vendor
/// ultimately included that call in a subscription or put it on an invoice.
enum BillingProvider: String, CaseIterable, Codable, Identifiable, Sendable {
    case claude
    case codex
    case cursor

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .cursor: "Cursor"
        }
    }

    static func classify(_ rawProvider: String) -> BillingProvider? {
        let normalized = rawProvider
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.contains("claude") { return .claude }
        if normalized.contains("codex") { return .codex }
        if normalized.contains("cursor") { return .cursor }
        return nil
    }
}

enum BillingCoverageMode: String, CaseIterable, Identifiable, Sendable {
    case automatic
    case covered
    case billable

    var id: String { rawValue }

    var label: String {
        switch self {
        case .automatic: "Automatic"
        case .covered: "Subscription-covered"
        case .billable: "Billable / API key"
        }
    }
}

enum BillingResolution: String, Sendable, Equatable {
    case covered
    case billable
    case unknown
}

struct BillingProviderPolicy: Sendable, Equatable {
    let mode: BillingCoverageMode
    let automaticResolution: BillingResolution
    let reason: String

    var resolution: BillingResolution {
        switch mode {
        case .automatic: automaticResolution
        case .covered: .covered
        case .billable: .billable
        }
    }
}

struct BillingProviderLine: Identifiable, Sendable, Equatable {
    var id: BillingProvider { provider }
    let provider: BillingProvider
    let apiEquivalentUSD: Double
    let subscriptionCoveredUSD: Double
    let estimatedBillableUSD: Double
    let resolution: BillingResolution
    let reason: String
}

struct BillingCostBreakdown: Equatable, Sendable {
    let apiEquivalentUSD: Double
    let subscriptionCoveredUSD: Double
    let estimatedBillableUSD: Double
    let unknownAttributionUSD: Double
    let providers: [BillingProviderLine]
}

enum BillingCostCalculator {
    static func breakdown(
        apiEquivalentUSD: Double,
        providerCosts: [String: Double],
        policies: [BillingProvider: BillingProviderPolicy]
    ) -> BillingCostBreakdown {
        let gross = max(0, apiEquivalentUSD)
        var grouped: [BillingProvider: Double] = [:]
        for (rawProvider, rawCost) in providerCosts {
            let cost = max(0, rawCost)
            if let provider = BillingProvider.classify(rawProvider) {
                grouped[provider, default: 0] += cost
            }
        }

        let lines = BillingProvider.allCases.compactMap { provider -> BillingProviderLine? in
            guard let cost = grouped[provider], cost > 0 else { return nil }
            let policy = policies[provider] ?? BillingProviderPolicy(
                mode: .automatic,
                automaticResolution: .unknown,
                reason: "Billing mode could not be detected"
            )
            let resolution = policy.resolution
            return BillingProviderLine(
                provider: provider,
                apiEquivalentUSD: cost,
                subscriptionCoveredUSD: resolution == .covered ? cost : 0,
                // Unknown attribution is counted as estimated billable so an
                // uncertain login can never silently suppress a real alert.
                estimatedBillableUSD: resolution == .covered ? 0 : cost,
                resolution: resolution,
                reason: policy.reason
            )
        }

        let attributed = lines.reduce(0) { $0 + $1.apiEquivalentUSD }
        let remainder = max(0, gross - attributed)
        let covered = min(gross, lines.reduce(0) { $0 + $1.subscriptionCoveredUSD })
        let unknown = min(
            gross,
            lines.filter { $0.resolution == .unknown }.reduce(0) { $0 + $1.apiEquivalentUSD }
                + remainder
        )
        let estimated = max(0, gross - covered)
        return BillingCostBreakdown(
            apiEquivalentUSD: gross,
            subscriptionCoveredUSD: covered,
            // Provider sums can differ from the gross by a few binary floating
            // point ulps. Never surface that arithmetic dust as a real charge.
            estimatedBillableUSD: estimated < 0.000_001 ? 0 : estimated,
            unknownAttributionUSD: unknown,
            providers: lines
        )
    }
}
