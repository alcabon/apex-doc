/**
 * @description Resolves the VAT rate that applies to an order line.
 *
 * Rates live in the `Tax_Rate__mdt` custom metadata type so a rate change is a
 * deployment rather than a code edit. The provider caches them for the life of
 * the transaction.
 *
 * @author Alain Cabon
 * @group Billing
 * @since 1.0
 * @version 2.1
 * @see OrderCalculator
 *
 * @history 2.1  2026-08-15  A. Cabon   Rates read from Tax_Rate__mdt
 * @history 2.0  2026-03-02  A. Cabon   Added reduced-rate categories
 * @history 1.0  2025-11-20  A. Cabon   Initial version
 */
public with sharing class TaxRateProvider {
    /** @description Rate applied when a category has no specific entry. */
    public static final Decimal STANDARD_RATE = 0.20;

    /** @description Rates by category, filled on first use. */
    private static Map<String, Decimal> cachedRates;

    /**
     * @description Returns the rate for a product category.
     *
     * @param category Category API name; a category with no configured rate
     * falls back to {@link STANDARD_RATE}.
     * @return The rate as a fraction, so 20% comes back as `0.20`.
     * @example
     * ```
     * Decimal rate = TaxRateProvider.rateFor('BOOKS');
     * Decimal gross = net * (1 + rate);
     * ```
     */
    public static Decimal rateFor(String category) {
        if (cachedRates == null) {
            loadRates();
        }
        return cachedRates.containsKey(category) ? cachedRates.get(category) : STANDARD_RATE;
    }

    /**
     * @description Drops the cache so the next lookup re-reads the metadata.
     * Tests use this between assertions; production code should not need it.
     *
     * @history 2.0  2026-03-02  A. Cabon   Extracted from rateFor
     */
    @TestVisible
    private static void resetCache() {
        cachedRates = null;
    }

    /**
     * @description Reads every configured rate into the cache.
     */
    private static void loadRates() {
        cachedRates = new Map<String, Decimal>();
        for (Tax_Rate__mdt rate : Tax_Rate__mdt.getAll().values()) {
            cachedRates.put(rate.Category__c, rate.Rate__c);
        }
    }
}
