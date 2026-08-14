/**
 * Service layer for Account records.
 *
 * Wraps the queries and DML the UI controllers need so that sharing rules and
 * validation live in one place.
 *
 * @author Alain Cabon
 * @date 2026-02-11
 * @since 1.0
 * @group Account Management
 * @see IAccountProcessor
 */
public with sharing class AccountService {
    /** Name given to accounts created without one. */
    private static final String DEFAULT_NAME = 'Unnamed Account';

    /** Number of records touched by the current instance. */
    private Integer processedCount = 0;

    /**
     * Accounts indexed by their industry, populated lazily by {@link warmCache}.
     */
    private Map<String, List<Account>> accountsByIndustry;

    /**
     * Name applied to the next account created by this service.
     */
    public String pendingName { get; set; }

    /**
     * Number of records processed since the service was instantiated.
     */
    public Integer processedTotal {
        get {
            return this.processedCount;
        }
    }

    /**
     * Creates a service with an empty counter.
     */
    public AccountService() {
        this.processedCount = 0;
    }

    /**
     * Creates a service that continues an existing count.
     *
     * @param initialCount Number of records already processed upstream.
     */
    public AccountService(Integer initialCount) {
        this.processedCount = initialCount;
    }

    /**
     * Finds accounts whose name matches a search term.
     *
     * @param searchTerm Fragment matched against `Account.Name`, SOQL wildcards allowed.
     * @param maxResults Upper bound on the number of rows returned.
     * @return Matching accounts, newest first; never null.
     * @throws QueryException When the running user cannot read Account.
     * @example
     * AccountService service = new AccountService();
     * List<Account> hits = service.findAccounts('Acme%', 10);
     * System.debug(hits.size());
     */
    public List<Account> findAccounts(String searchTerm, Integer maxResults) {
        return [
            SELECT Id, Name, Industry
            FROM Account
            WHERE Name LIKE :searchTerm
            ORDER BY CreatedDate DESC
            LIMIT :maxResults
        ];
    }

    /**
     * Loads every account into the industry cache.
     *
     * @return The number of accounts cached.
     */
    public Integer warmCache() {
        this.accountsByIndustry = new Map<String, List<Account>>();
        List<Account> all = [SELECT Id, Name, Industry FROM Account LIMIT 10000];
        for (Account record : all) {
            String key = record.Industry == null ? 'Unknown' : record.Industry;
            if (!this.accountsByIndustry.containsKey(key)) {
                this.accountsByIndustry.put(key, new List<Account>());
            }
            this.accountsByIndustry.get(key).add(record);
        }
        return all.size();
    }

    /**
     * Applies a processor to every account in a chunk.
     *
     * @param records Accounts to run through the processor.
     * @param processor Strategy invoked once per record.
     * @return Accounts the processor accepted.
     */
    public List<Account> applyAll(List<Account> records, IAccountProcessor processor) {
        List<Account> accepted = new List<Account>();
        for (Account record : records) {
            if (processor.validate(record)) {
                processor.process(record);
                accepted.add(record);
                this.processedCount++;
            }
        }
        return accepted;
    }

    /**
     * Queues an account for asynchronous enrichment.
     *
     * @param recordId Identifier of the account to enrich.
     * @deprecated Use `EnrichmentQueueable` instead; `@future` cannot be chained.
     */
    @future
    public static void enrichAsync(Id recordId) {
        System.debug(LoggingLevel.INFO, 'Enriching ' + recordId);
    }

    /**
     * Lifecycle state of an account within the enrichment pipeline.
     */
    public enum Status {
        /** Not yet picked up. */
        PENDING,
        /** Currently being enriched. */
        RUNNING,
        /** Enrichment finished successfully. */
        DONE
    }

    /**
     * Builds Account records for tests.
     *
     * @group Testing
     */
    @TestVisible
    private class TestDataFactory {
        /** Number of records handed out so far. */
        private static Integer created = 0;

        /**
         * Builds one unsaved account.
         *
         * @return An in-memory account with a unique name.
         */
        public static Account buildAccount() {
            created++;
            return new Account(Name = DEFAULT_NAME + ' ' + created);
        }
    }
}
