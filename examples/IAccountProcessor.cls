/**
 * Strategy applied to an Account before it is persisted.
 *
 * Implementations must be side-effect free in {@link validate} so callers can
 * probe a record without committing to processing it.
 *
 * @author Alain Cabon
 * @group Account Management
 */
public interface IAccountProcessor {
    /**
     * Mutates the record in place.
     *
     * @param record Account to enrich; modified in place.
     */
    void process(Account record);

    /**
     * Decides whether the record can be processed.
     *
     * @param record Account to inspect.
     * @return True when {@link process} may be called on this record.
     */
    Boolean validate(Account record);
}
