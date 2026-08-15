/**
 * @description Buckets a list of records by the value of one field, so callers
 * stop writing the same for loop every time they need records grouped a new
 * way.
 *
 * Everything here is static and side-effect free — no DML, no SOQL. Hand it
 * records you have already queried.
 *
 * @group Collection Utilities
 * @author Alain Cabon
 * @version 2026-08-15
 * @see AccountService
 */
public with sharing class SObjectGrouper {
    /** @description Key used for records whose grouping field is null. */
    public static final String NULL_KEY = '__null__';

    /**
     * @description Groups records by the value of `fieldName`, keeping the
     * order they arrived in. The first record of each bucket is the first one
     * seen in `records`, which matters when the caller only wants a
     * representative row per group.
     *
     * Type safety is the awkward part, and worth explaining because the
     * signature looks lossier than it is. Apex has no type parameters on
     * methods, so the parameter is a generic `List<SObject>` and the buckets
     * come back as `List<SObject>` too. Casting a bucket to the concrete type
     * is safe: a list built from `Contact` records is still a list of contacts
     * underneath, and the runtime check succeeds.
     *
     * Two rules keep the result predictable:
     *
     * * A record whose field is null lands under {@link NULL_KEY} rather than
     *   being dropped, so the bucket sizes always add up to `records.size()`.
     * * Keys are `String.valueOf` of the field value, so `Id`, `Date` and
     *   `Decimal` fields all group the way you would expect without the caller
     *   converting anything first.
     *
     * @param fieldName API name of the field to group by. It has to be present
     * on the records — a field that was never queried raises rather than
     * quietly producing one empty bucket.
     * @param records Records to group. A null or empty list gives back an empty
     * map instead of throwing.
     * @return Buckets keyed by field value, in the order first encountered.
     * @throws SObjectException When `fieldName` was not queried on a record.
     * @see countByField
     * @example
     * ```
     * List<Contact> contacts = [SELECT Id, AccountId, LastName FROM Contact LIMIT 200];
     * Map<String, List<SObject>> byAccount = SObjectGrouper.groupByField('AccountId', contacts);
     *
     * for (String accountId : byAccount.keySet()) {
     *     List<Contact> forAccount = (List<Contact>) byAccount.get(accountId);
     *     System.debug(accountId + ' -> ' + forAccount.size() + ' contacts');
     * }
     * ```
     */
    public static Map<String, List<SObject>> groupByField(
        String fieldName,
        List<SObject> records
    ) {
        Map<String, List<SObject>> buckets = new Map<String, List<SObject>>();
        if (records == null || records.isEmpty()) {
            return buckets;
        }

        for (SObject record : records) {
            Object value = record.get(fieldName);
            String key = value == null ? NULL_KEY : String.valueOf(value);
            if (!buckets.containsKey(key)) {
                buckets.put(key, new List<SObject>());
            }
            buckets.get(key).add(record);
        }
        return buckets;
    }

    /**
     * @description Counts records per field value. Equivalent to calling
     * {@link groupByField} and taking each bucket's size, but without building
     * the intermediate lists — worth using on large result sets where the
     * records themselves are not needed.
     *
     * @param fieldName API name of the field to count by.
     * @param records Records to count. A null or empty list gives back an empty
     * map.
     * @return How many records carry each field value.
     * @example
     * ```
     * Map<String, Integer> perStage = SObjectGrouper.countByField('StageName', opportunities);
     * System.debug(perStage.get('Closed Won'));
     * ```
     */
    public static Map<String, Integer> countByField(String fieldName, List<SObject> records) {
        Map<String, Integer> counts = new Map<String, Integer>();
        if (records == null || records.isEmpty()) {
            return counts;
        }

        for (SObject record : records) {
            Object value = record.get(fieldName);
            String key = value == null ? NULL_KEY : String.valueOf(value);
            Integer seen = counts.containsKey(key) ? counts.get(key) : 0;
            counts.put(key, seen + 1);
        }
        return counts;
    }

    /**
     * @description Returns the single record per group, for the common case
     * where the grouping field is unique and the caller wants a lookup table
     * rather than buckets.
     *
     * When the field is not unique the last record wins, matching the behaviour
     * of `Map.put`. Use {@link groupByField} if collisions matter.
     *
     * @param fieldName API name of the field to key by.
     * @param records Records to index.
     * @return One record per distinct field value.
     */
    public static Map<String, SObject> indexByField(String fieldName, List<SObject> records) {
        Map<String, SObject> index = new Map<String, SObject>();
        for (String key : groupByField(fieldName, records).keySet()) {
            List<SObject> bucket = groupByField(fieldName, records).get(key);
            index.put(key, bucket[bucket.size() - 1]);
        }
        return index;
    }
}
