// Deliberately under-documented: use this file to try `apexdoc annotate`
// and `apexdoc check`.
public class OrderCalculator {
    private static final Decimal VAT_RATE = 0.20;

    private Map<Id, List<List<OrderItem>>> batchedItems;

    public Decimal lastTotal { get; set; }

    public OrderCalculator(Map<Id, List<List<OrderItem>>> batchedItems) {
        this.batchedItems = batchedItems;
    }

    /**
     * @description Totals one order, VAT included.
     *
     * @param orderId Order to total.
     */
    public Decimal total(Id orderId, Boolean includeVat) {
        Decimal sum = 0;
        for (List<OrderItem> chunk : this.batchedItems.get(orderId)) {
            for (OrderItem item : chunk) {
                sum += item.Quantity * item.UnitPrice;
            }
        }
        this.lastTotal = includeVat ? sum * (1 + VAT_RATE) : sum;
        return this.lastTotal;
    }

    public void reset() {
        this.lastTotal = 0;
    }

    public Map<Id, Decimal> totalAll(Set<Id> orderIds, Boolean includeVat) {
        Map<Id, Decimal> totals = new Map<Id, Decimal>();
        for (Id orderId : orderIds) {
            totals.put(orderId, total(orderId, includeVat));
        }
        return totals;
    }
}
