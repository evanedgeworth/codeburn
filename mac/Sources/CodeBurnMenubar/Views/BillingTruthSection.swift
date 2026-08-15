import SwiftUI

/// Keeps economic value and cash cost visibly separate. Local session logs can
/// estimate attribution; vendor billing APIs are the only source labeled actual.
struct BillingTruthSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let truth = store.billingTruth(for: store.payload.current)
        let freshSnapshots = store.billingSnapshots.values.filter { !$0.isStale }
        let actualMTD = freshSnapshots.compactMap(\.monthToDateUSD).reduce(0, +)

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                BillingTruthMetric(
                    label: "API-equivalent",
                    value: truth.breakdown.apiEquivalentUSD.asCompactCurrency(),
                    help: "Value at public API rates"
                )
                BillingTruthMetric(
                    label: "Covered",
                    value: truth.breakdown.subscriptionCoveredUSD.asCompactCurrency(),
                    help: "Included in memberships"
                )
                BillingTruthMetric(
                    label: "Billable est.",
                    value: truth.breakdown.estimatedBillableUSD.asCompactCurrency(),
                    help: "Used for alerts"
                )
            }

            HStack(spacing: 5) {
                Image(systemName: confidenceIcon(truth.confidence))
                    .font(.system(size: 9, weight: .semibold))
                Text(truth.confidence.label)
                if !freshSnapshots.isEmpty {
                    Text("·")
                    Text("Vendor actual MTD \(actualMTD.asCompactCurrency())")
                }
                Spacer(minLength: 0)
            }
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(.secondary)

            let value = store.membershipValueSummary
            if let ratio = value.equivalentValueRatio, value.monthToDateAPIEquivalentUSD > 0 {
                Text("Membership value: \(value.monthToDateAPIEquivalentUSD.asCompactCurrency()) API-equivalent / \(value.monthlyMembershipUSD.asCompactCurrency()) monthly = \(String(format: "%.1f×", ratio))")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 2)
        .padding(.bottom, 10)
    }

    private func confidenceIcon(_ confidence: BillingConfidence) -> String {
        switch confidence {
        case .vendorReconciled: "checkmark.seal.fill"
        case .authDetected: "person.badge.key.fill"
        case .explicitSetting: "slider.horizontal.3"
        case .localEstimate: "questionmark.circle.fill"
        }
    }
}

private struct BillingTruthMetric: View {
    let label: String
    let value: String
    let help: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .monospacedDigit()
            Text(help)
                .font(.system(size: 8.5))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
