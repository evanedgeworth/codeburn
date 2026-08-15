import Foundation
import Testing
@testable import CodeBurnMenubar

struct BillingCostTests {
    @Test func classifiesProviderFamilies() {
        #expect(BillingProvider.classify("claude") == .claude)
        #expect(BillingProvider.classify("Codex") == .codex)
        #expect(BillingProvider.classify("Cursor Agent") == .cursor)
        #expect(BillingProvider.classify("cursor-agent") == .cursor)
        #expect(BillingProvider.classify("gemini") == nil)
    }

    @Test func excludesOnlyExplicitlyCoveredProviders() {
        let result = BillingCostCalculator.breakdown(
            apiEquivalentUSD: 150,
            providerCosts: ["codex": 100, "claude": 25, "gemini": 25],
            policies: [
                .codex: BillingProviderPolicy(mode: .covered, automaticResolution: .unknown, reason: "Covered"),
                .claude: BillingProviderPolicy(mode: .covered, automaticResolution: .unknown, reason: "Covered"),
            ]
        )

        #expect(result.apiEquivalentUSD == 150)
        #expect(result.subscriptionCoveredUSD == 125)
        #expect(result.estimatedBillableUSD == 25)
    }

    @Test func neverReturnsNegativeBillableCost() {
        let result = BillingCostCalculator.breakdown(
            apiEquivalentUSD: 10,
            providerCosts: ["codex": 12],
            policies: [
                .codex: BillingProviderPolicy(mode: .covered, automaticResolution: .unknown, reason: "Covered"),
            ]
        )

        #expect(result.subscriptionCoveredUSD == 10)
        #expect(result.estimatedBillableUSD == 0)
    }

    @Test func unknownAutomaticAttributionFailsSafeAsBillable() {
        let result = BillingCostCalculator.breakdown(
            apiEquivalentUSD: 20,
            providerCosts: ["cursor": 15, "other": 5],
            policies: [
                .cursor: BillingProviderPolicy(
                    mode: .automatic,
                    automaticResolution: .unknown,
                    reason: "Unavailable"
                ),
            ]
        )

        #expect(result.subscriptionCoveredUSD == 0)
        #expect(result.estimatedBillableUSD == 20)
        #expect(result.unknownAttributionUSD == 20)
    }

    @Test func providerHistoryProducesIndependentLedgers() throws {
        let json = """
        [{"date":"2026-08-14","cost":100,"savingsUSD":0,"calls":2,"inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":0,"topModels":[],"providers":{"codex":80,"cursor":20}}]
        """
        let history = try JSONDecoder().decode([DailyHistoryEntry].self, from: Data(json.utf8))
        let policies: [BillingProvider: BillingProviderPolicy] = [
            .codex: BillingProviderPolicy(mode: .covered, automaticResolution: .unknown, reason: "Covered"),
            .cursor: BillingProviderPolicy(mode: .billable, automaticResolution: .unknown, reason: "Billable"),
        ]

        let day = try #require(BillingHistoryCalculator.entries(history, policies: policies).first)
        #expect(day.apiEquivalentUSD == 100)
        #expect(day.subscriptionCoveredUSD == 80)
        #expect(day.estimatedBillableUSD == 20)
        #expect(day.unknownAttributionUSD == 0)
    }

    @Test func legacyHistoryWithoutProvidersRemainsFailSafe() throws {
        let json = """
        [{"date":"2026-08-14","cost":12,"calls":1,"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}]
        """
        let history = try JSONDecoder().decode([DailyHistoryEntry].self, from: Data(json.utf8))
        let day = try #require(BillingHistoryCalculator.entries(history, policies: [:]).first)
        #expect(day.estimatedBillableUSD == 12)
        #expect(day.unknownAttributionUSD == 12)
    }
}
