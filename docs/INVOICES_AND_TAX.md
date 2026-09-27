# Invoice and Tax Configuration

## Current calculation

Product prices and checkout totals are currently treated as tax-inclusive. The
existing invoice displayed an 18% inclusive-tax extraction from the final order
total. The application does not calculate product-specific GST classifications
or add GST on top of the customer-facing checkout total.

Stage 5 preserves that behavior while recording each order's financial values
in integer paise (`*_minor`) at order creation. For a tax-inclusive gross amount
`G` and configured rate `R` basis points, taxable value is rounded to the
nearest paise using `G * 10000 / (10000 + R)`; tax is the remainder. The
snapshot records subtotal, discount, delivery charge, taxable value, tax rate,
tax amount, currency and grand total. COD and captured online orders use the
same invoice snapshot model. Online checkout captures the rate and seller
details in the durable checkout intent so later configuration changes do not
rewrite the invoice.

The current model applies one rate to the aggregate tax-inclusive checkout
amount, including delivery after discount. That is a compatibility behavior,
not a determination that every product, discount or delivery service has the
same legal GST treatment. Product-level HSN/SAC classification, multiple tax
rates, place-of-supply treatment and component-level tax allocation are not
implemented. Obtain qualified tax review and confirm the required treatment
before using invoices for a public commercial launch.

`GST_RATE_BPS` configures the inclusive extraction rate. It defaults to `1800`
(18%) solely to preserve the existing invoice output. It does not change the
checkout amount charged. Configure and verify the value only after business/tax
review; do not infer it from this default.

## Order and invoice snapshots

Order items store the purchased product name, unit price, quantity and
configuration; invoices read these order rows rather than the current catalog.
The `orders.invoice_snapshot` JSON object records immutable order-level money
and seller values. Legacy orders are backfilled to reproduce the previous
18%-inclusive invoice arithmetic. Seller identity was not historically stored,
so legacy snapshots intentionally leave those fields empty rather than
inventing legal details. The legacy extraction rounds taxable value to whole
rupees, matching the previous invoice path; new order snapshots round in paise.

The customer invoice route renders a printable server-rendered invoice. A
PDFKit helper also reads the same stored invoice snapshot. The invoice shows
the stored billing/delivery details, order items, payment method/status and
financial totals.

## Production values to supply and verify

Set these in the deployment environment, not in tracked files:

- `SELLER_LEGAL_NAME`: the actual contracting/legal seller name.
- `SELLER_REGISTERED_ADDRESS`: the seller address required for business
  documents.
- `SELLER_GSTIN`: the actual GSTIN only if applicable and verified.
- `SUPPORT_EMAIL` and `SUPPORT_PHONE`: verified customer-support contacts.
- `GST_RATE_BPS`: a rate and tax treatment approved for the actual products and
  delivery model.

The application displays a configuration warning on invoices when legal name
or registered address is absent. Confirm seller identity, invoice wording,
customer billing fields, GST registration/classification, shipping treatment,
and required invoice particulars with the responsible business and tax
reviewers before launch. This document is operational guidance, not legal or
tax advice.
