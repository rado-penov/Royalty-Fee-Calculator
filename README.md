# Royalty fee Calculation

Scheduled script that calculates franchise (royalty) and marketing fees for
Pret franchisees and stores the result in the custom record
`customrecord_pret_franchise_rfc`.

## Files

| Path | Purpose |
|------|---------|
| `src/pret_rfc_calculate_fees_ss.js` | SuiteScript 2.1 Scheduled Script |
| `Docs/Fields.xlsx` | Custom field IDs on Customer and the RFC custom record |

## What the script does

1. Reads the run date from the script parameter **Today is**
   (`custscript_pret_rfc_today_is`). If empty, uses the current date.
2. Loads the customer internal IDs from saved search
   `customsearch_pret_rfc_customers`.
3. Skips any franchisee that already has an RFC record for that date
   (safe to re-run).
4. Reads Revenue, Contract Rate and Contract Marketing Fee for each customer
   from the saved search columns (no extra lookups on the customer record).
5. Creates one `customrecord_pret_franchise_rfc` per franchisee:

| RFC field | Value |
|-----------|-------|
| Date | today (date the record is created); *Today is* overrides it on test deployments only |
| Franchisee | the customer |
| Revenue | `custentity_pret_revenue_for_rfc_monthly` |
| Contract Rate (%) | `custentity_pret_contract_rate_percent` |
| Marketing Rate (%) | `custentity_pret_contract_marketing_fee` |
| Franchise Amount | Revenue x Contract Rate / 100 |
| Marketing Amount | Revenue x Marketing Rate / 100 |

### Single-invoice customers

When **Single Invoice** (`custentity_pret_single_invoice`) is ticked on the
customer, the customer itself gets no RFC record. Instead:

- One RFC record is created per customer address that has a **Shop ID**
  (`custrecord_pret_shop_id`), with the same Franchisee and Name as above, and:

| RFC field | Value |
|-----------|-------|
| Revenue | `custrecord_pret_revenue_monthly` on the address |
| Contract Rate (%) | `custrecord_pret_contract_rate_percent_ad` on the address |
| Marketing Rate (%) | `custrecord_pret_contract_mar_fee_ad` on the address |
| Shop Number (`custrecord_pret_shop_number_department`) | `custrecord_pret_shop_id` on the address |

- The monthly revenue of all the customer's addresses is summed and written to
  `custentity_pret_revenue_for_rfc_monthly` on the customer.
- Addresses without a Shop ID get no RFC record (a warning is logged if they
  carry revenue); their revenue is still included in the customer total.
- Re-runs skip shops that already have a record for the date.

Amounts are rounded to 2 decimals. If the script runs low on governance
units it reschedules itself and continues where it left off.

## Deployment

1. **Upload** `src/pret_rfc_calculate_fees_ss.js` to the File Cabinet
   (Customization > Scripting > Scripts > New).
2. **Create the script record** (type Scheduled Script).
   Script ID: `customscript_pret_rfc_calculate_fees`.
3. **Add the parameter** on the script record, *Parameters* tab:
   - Label: `Today is`
   - ID: `custscript_pret_rfc_today_is`
   - Type: `Date`
   - Not mandatory (leave blank for production).
4. **Create a deployment**:
   - Status: `Scheduled`
   - Schedule: Daily, every 1 day, at the required time
   - Log level: `Audit` (use `Debug` while testing)
   - Leave *Today is* empty.
5. **Test deployment** (optional): a second deployment with status
   `Not Scheduled`, *Today is* set to the date you want to simulate.
   Run it with *Save and Execute*.

## Notes

- The saved search must be of type Customer and must include these columns:
  `custentity_pret_revenue_for_rfc_monthly`,
  `custentity_pret_contract_rate_percent`,
  `custentity_pret_contract_marketing_fee`.
  The script checks for them on start and stops with a clear error if any is
  missing. Other columns and filters can be changed freely.
- The *Today is* parameter only controls the date stamped on the RFC record.
  It does not change which customers the saved search returns.
