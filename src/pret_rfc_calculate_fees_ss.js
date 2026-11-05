/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Pret - Royalty Fees Calculation
 * ----------------------------------------------------------------------------
 * Created 11/2026 by NS Nexus on behalf of Pret a Manger (Europe) Limited.
 *
 * Version: 1.3
 *
 * Version history:
 *   1.0  Initial version - one RFC record per franchisee.
 *   1.1  Runs only on the 1st of the month (London date); record name
 *        "<franchisee>-<DDMMYY>"; run date carried over on reschedule.
 *   1.2  Single-invoice customers: one RFC record per shop (address), revenue
 *        from the address, address revenue summed back to the customer.
 *   1.3  Single-invoice customers: contract and marketing rates taken from the
 *        address.
 * ----------------------------------------------------------------------------
 * Deployed daily, but only does work when the run date (London time) is the
 * 1st of the month. For every customer returned by the saved search
 * 'customsearch_pret_rfc_customers' it creates 'customrecord_pret_franchise_rfc'
 * records holding the revenue, contract rate, marketing rate and the two
 * calculated amounts. The record name is "<franchisee>-<DDMMYY>",
 * e.g. "C00001202 EPIGO-011126".
 *
 * Two kinds of customer:
 *
 *   Single invoice = F (standard)
 *     One RFC record for the customer. Revenue comes from the customer field
 *     custentity_pret_revenue_for_rfc_monthly (saved search column).
 *
 *   Single invoice = T (custentity_pret_single_invoice)
 *     One RFC record per shop, i.e. per customer address that has a Shop ID
 *     (custrecord_pret_shop_id). Revenue for each record comes from the
 *     address field custrecord_pret_revenue_monthly, the rates from the address
 *     fields custrecord_pret_contract_rate_percent_ad (Contract Rate) and
 *     custrecord_pret_contract_mar_fee_ad (Marketing Rate), and the Shop ID is written
 *     to custrecord_pret_shop_number_department. No RFC record is created for
 *     the customer itself. The revenue of all addresses is summed and written
 *     back to custentity_pret_revenue_for_rfc_monthly on the customer.
 *     Addresses without a Shop ID get no RFC record (a warning is logged if
 *     they carry revenue), but their revenue is still included in the sum.
 *
 * The rates are read from the saved search results, so the saved search must
 * include these customer fields as columns:
 *   custentity_pret_revenue_for_rfc_monthly
 *   custentity_pret_contract_rate_percent
 *   custentity_pret_contract_marketing_fee
 * The script checks for them on start and fails with a clear error if missing.
 * custentity_pret_single_invoice is added to the search automatically if it
 * is not already a column.
 *
 * Script parameter:
 *   custscript_pret_rfc_today_is (Date, optional)
 *     Date written to the RFC record. Leave empty on the production deployment
 *     so the script uses the real "today" in London; set it on a test
 *     deployment to simulate a specific run date (must be a 1st to do work).
 *
 * Idempotency: a standard customer that already has an RFC record for the run
 * date is skipped; for a single-invoice customer each shop that already has a
 * record for the run date is skipped. The script can therefore be re-run (or
 * rescheduled) safely.
 */
define(['N/search', 'N/record', 'N/runtime', 'N/task', 'N/log', 'N/format'],
    (search, record, runtime, task, log, format) => {

        const SAVED_SEARCH_ID = 'customsearch_pret_rfc_customers';
        const RFC_RECORD_TYPE = 'customrecord_pret_franchise_rfc';
        const PARAM_TODAY_IS = 'custscript_pret_rfc_today_is';

        // Customer fields (Docs/Fields.xlsx - sheet "Customer")
        const CUST = {
            REVENUE: 'custentity_pret_revenue_for_rfc_monthly',
            CONTRACT_RATE: 'custentity_pret_contract_rate_percent',
            MARKETING_RATE: 'custentity_pret_contract_marketing_fee',
            SINGLE_INVOICE: 'custentity_pret_single_invoice'
        };

        // Custom fields on the customer address form
        const ADDR = {
            SHOP_ID: 'custrecord_pret_shop_id',
            REVENUE: 'custrecord_pret_revenue_monthly',
            CONTRACT_RATE: 'custrecord_pret_contract_rate_percent_ad',
            MARKETING_RATE: 'custrecord_pret_contract_mar_fee_ad'
        };

        // Custom record fields (Docs/Fields.xlsx - sheet "CR")
        const RFC = {
            NAME: 'name',
            DATE: 'custrecord_pret_rfc_date',
            FRANCHISEE: 'custrecord_pret_franchisee',
            SHOP_NUMBER: 'custrecord_pret_shop_number_department',
            REVENUE: 'custrecord_pret_revenue',
            CONTRACT_RATE: 'custrecord_pret_contract_rate_percent',
            MARKETING_RATE: 'custrecord_pret_marketing_rate',
            FRANCHISE_AMOUNT: 'custrecord_pret_franchise_amount',
            MARKETING_AMOUNT: 'custrecord_pret_marketing_amount'
        };

        // Stop and reschedule when fewer units than this remain.
        const MIN_REMAINING_USAGE = 200;

        /**
         * Entry point.
         * @param {Object} context
         */
        const execute = (context) => {
            const script = runtime.getCurrentScript();
            const runDate = getRunDate(script);
            log.audit('RFC start', 'Run date: ' + format.format({ value: runDate, type: format.Type.DATE }));

            if (runDate.getDate() !== 1) {
                log.audit('RFC skipped', 'Run date is not the 1st of the month');
                return;
            }

            const customers = getCustomersFromSavedSearch();
            log.audit('RFC customers', 'Saved search returned ' + customers.length + ' customer(s)');
            if (!customers.length) {
                return;
            }

            const existing = getExistingRecordsOnDate(runDate);
            // Standard customers are done once they have any record for the date.
            // Single-invoice customers are always visited; their shops are checked one by one.
            const pending = customers.filter(c => c.singleInvoice || !existing.has(c.id));
            log.audit('RFC pending', pending.length + ' customer(s) to process (' +
                pending.filter(c => c.singleInvoice).length + ' single invoice), ' +
                (customers.length - pending.length) + ' already have a record for this date');
            if (!pending.length) {
                return;
            }

            const stats = { created: 0, customersUpdated: 0, errors: 0 };

            for (const cust of pending) {
                if (isLowOnUsage(script)) {
                    log.audit('RFC governance', 'Low usage - rescheduling. Progress: ' + JSON.stringify(stats));
                    reschedule(script, runDate);
                    return;
                }
                try {
                    if (cust.singleInvoice) {
                        const finished = processSingleInvoiceCustomer(cust, runDate, existing.get(cust.id) || new Set(), stats, script);
                        if (!finished) {
                            log.audit('RFC governance', 'Low usage during customer ' + cust.id +
                                ' - rescheduling. Progress: ' + JSON.stringify(stats));
                            reschedule(script, runDate);
                            return;
                        }
                    } else {
                        createRfcRecord(cust.id, runDate, {
                            revenue: cust.revenue,
                            contractRate: cust.contractRate,
                            marketingRate: cust.marketingRate,
                            shopId: null
                        });
                        stats.created++;
                    }
                } catch (e) {
                    stats.errors++;
                    log.error('RFC processing failed - customer ' + cust.id, e);
                }
            }

            log.audit('RFC done', JSON.stringify(stats));
        };

        /**
         * Single-invoice customer: one RFC record per shop address, then write
         * the summed address revenue back to the customer.
         * @param {{id:string, revenue:number, contractRate:number, marketingRate:number}} cust
         * @param {Date} runDate
         * @param {Set<string>} doneShops shop ids that already have a record for runDate
         * @param {{created:number, customersUpdated:number, errors:number}} stats
         * @param {runtime.Script} script
         * @returns {boolean} false if it stopped early for governance (customer not finished)
         */
        const processSingleInvoiceCustomer = (cust, runDate, doneShops, stats, script) => {
            const addresses = getCustomerAddresses(cust.id);
            const total = round2(addresses.reduce((sum, a) => sum + a.revenue, 0));

            for (const addr of addresses) {
                if (!addr.shopId) {
                    if (addr.revenue) {
                        log.audit('RFC address without Shop ID', 'Customer ' + cust.id + ', address "' + addr.label +
                            '" has revenue ' + addr.revenue + ' but no Shop ID - no RFC record created (revenue is still included in the customer total)');
                    }
                    continue;
                }
                if (doneShops.has(addr.shopId)) {
                    continue;
                }
                if (isLowOnUsage(script)) {
                    return false;
                }
                try {
                    // Rates come from the address, not the customer.
                    createRfcRecord(cust.id, runDate, addr);
                    doneShops.add(addr.shopId);
                    stats.created++;
                } catch (e) {
                    stats.errors++;
                    log.error('RFC create failed - customer ' + cust.id + ' shop ' + addr.shopId, e);
                }
            }

            if (total !== cust.revenue) {
                const values = {};
                values[CUST.REVENUE] = total;
                record.submitFields({
                    type: record.Type.CUSTOMER,
                    id: cust.id,
                    values: values,
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                stats.customersUpdated++;
                log.debug('RFC customer revenue updated', 'customer=' + cust.id + ' ' + cust.revenue + ' -> ' + total);
            }
            return true;
        };

        /**
         * Shop ID, monthly revenue and rates of every address on the customer.
         * @param {string} customerId
         * @returns {{label:string, shopId:string, revenue:number, contractRate:number, marketingRate:number}[]}
         */
        const getCustomerAddresses = (customerId) => {
            const custRec = record.load({ type: record.Type.CUSTOMER, id: customerId });
            const out = [];
            const lines = custRec.getLineCount({ sublistId: 'addressbook' });
            for (let line = 0; line < lines; line++) {
                const addr = custRec.getSublistSubrecord({ sublistId: 'addressbook', fieldId: 'addressbookaddress', line: line });
                const shopId = addr.getValue({ fieldId: ADDR.SHOP_ID });
                out.push({
                    label: custRec.getSublistValue({ sublistId: 'addressbook', fieldId: 'label', line: line }) || ('line ' + (line + 1)),
                    shopId: shopId ? String(shopId) : '',
                    revenue: toNumber(addr.getValue({ fieldId: ADDR.REVENUE })),
                    contractRate: toPercent(addr.getValue({ fieldId: ADDR.CONTRACT_RATE })),
                    marketingRate: toPercent(addr.getValue({ fieldId: ADDR.MARKETING_RATE }))
                });
            }
            return out;
        };

        const isLowOnUsage = (script) => script.getRemainingUsage() < MIN_REMAINING_USAGE;

        /**
         * Resolve the run date from the 'today is' parameter, falling back to
         * today's date in London.
         * @param {runtime.Script} script
         * @returns {Date}
         */
        const getRunDate = (script) => {
            const param = script.getParameter({ name: PARAM_TODAY_IS });
            let d;
            if (param instanceof Date) {
                d = param;
            } else if (param) {
                d = format.parse({ value: String(param), type: format.Type.DATE });
            } else {
                return getLondonToday(new Date());
            }
            // Normalise to midnight so comparisons on the date field are stable.
            return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        };

        /**
         * Today's calendar date in London (GMT/BST). Server-side JS runs in US
         * Pacific time regardless of the company time zone, so derive it from UTC.
         * BST runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on the
         * last Sunday of October.
         * @param {Date} now
         * @returns {Date} midnight (server local) of the London date
         */
        const getLondonToday = (now) => {
            const y = now.getUTCFullYear();
            const lastSundayUtc = (month) => {
                const d = new Date(Date.UTC(y, month + 1, 0, 1)); // last day of month, 01:00 UTC
                d.setUTCDate(d.getUTCDate() - d.getUTCDay());
                return d.getTime();
            };
            const t = now.getTime();
            const isBst = t >= lastSundayUtc(2) && t < lastSundayUtc(9);
            const london = new Date(t + (isBst ? 3600000 : 0));
            return new Date(london.getUTCFullYear(), london.getUTCMonth(), london.getUTCDate());
        };

        /**
         * Read customers and their revenue / rates / single-invoice flag from
         * the saved search. One entry per customer (duplicates from joined
         * columns are dropped).
         * @returns {{id:string, revenue:number, contractRate:number, marketingRate:number, singleInvoice:boolean}[]}
         */
        const getCustomersFromSavedSearch = () => {
            const srch = search.load({ id: SAVED_SEARCH_ID });
            assertSearchColumns(srch);
            if (getColumnNames(srch).indexOf(CUST.SINGLE_INVOICE) === -1) {
                srch.columns = srch.columns.concat([search.createColumn({ name: CUST.SINGLE_INVOICE })]);
            }

            const out = [];
            const seen = new Set();
            const paged = srch.runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach(range => {
                paged.fetch({ index: range.index }).data.forEach(row => {
                    const id = String(row.id);
                    if (seen.has(id)) {
                        return;
                    }
                    seen.add(id);
                    out.push({
                        id: id,
                        revenue: toNumber(row.getValue({ name: CUST.REVENUE })),
                        contractRate: toPercent(row.getValue({ name: CUST.CONTRACT_RATE })),
                        marketingRate: toPercent(row.getValue({ name: CUST.MARKETING_RATE })),
                        singleInvoice: toBool(row.getValue({ name: CUST.SINGLE_INVOICE }))
                    });
                });
            });
            return out;
        };

        /** Lower-case field ids of the search's columns. */
        const getColumnNames = (srch) => srch.columns.map(c => (typeof c === 'string' ? c : c.name).toLowerCase());

        /**
         * Fail fast if the saved search no longer exposes the fields we need.
         * @param {search.Search} srch
         */
        const assertSearchColumns = (srch) => {
            const names = getColumnNames(srch);
            const missing = [CUST.REVENUE, CUST.CONTRACT_RATE, CUST.MARKETING_RATE]
                .filter(f => names.indexOf(f) === -1);
            if (missing.length) {
                throw new Error('Saved search ' + SAVED_SEARCH_ID +
                    ' is missing required column(s): ' + missing.join(', '));
            }
        };

        /**
         * RFC records already dated runDate, grouped by franchisee.
         * @param {Date} runDate
         * @returns {Map<string, Set<string>>} franchisee id -> shop ids ('' = no shop)
         */
        const getExistingRecordsOnDate = (runDate) => {
            const existing = new Map();
            const dateStr = format.format({ value: runDate, type: format.Type.DATE });
            const paged = search.create({
                type: RFC_RECORD_TYPE,
                filters: [
                    [RFC.DATE, 'on', dateStr], 'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: [RFC.FRANCHISEE, RFC.SHOP_NUMBER]
            }).runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach(range => {
                paged.fetch({ index: range.index }).data.forEach(row => {
                    const fr = row.getValue({ name: RFC.FRANCHISEE });
                    if (!fr) {
                        return;
                    }
                    const key = String(fr);
                    if (!existing.has(key)) {
                        existing.set(key, new Set());
                    }
                    existing.get(key).add(String(row.getValue({ name: RFC.SHOP_NUMBER }) || ''));
                });
            });
            return existing;
        };

        /**
         * Create one RFC record.
         * Standard customers pass the customer's revenue and rates; single-invoice
         * customers pass the address's revenue, rates and shop ID.
         * @param {string} customerId franchisee
         * @param {Date} runDate
         * @param {{revenue:number, contractRate:number, marketingRate:number, shopId:(string|null)}} src
         * @returns {number} new record id
         */
        const createRfcRecord = (customerId, runDate, src) => {
            const revenue = src.revenue;
            const shopId = src.shopId;
            const franchiseAmount = round2(revenue * src.contractRate / 100);
            const marketingAmount = round2(revenue * src.marketingRate / 100);

            // Dynamic mode so getText() can return the franchisee display name after setValue().
            const rec = record.create({ type: RFC_RECORD_TYPE, isDynamic: true });
            rec.setValue({ fieldId: RFC.FRANCHISEE, value: customerId });
            // e.g. "C00001202 EPIGO-011126"
            rec.setValue({ fieldId: RFC.NAME, value: rec.getText({ fieldId: RFC.FRANCHISEE }) + '-' + toDdMmYy(runDate) });
            rec.setValue({ fieldId: RFC.DATE, value: runDate });
            if (shopId) {
                rec.setValue({ fieldId: RFC.SHOP_NUMBER, value: shopId });
            }
            rec.setValue({ fieldId: RFC.REVENUE, value: revenue });
            rec.setValue({ fieldId: RFC.CONTRACT_RATE, value: src.contractRate });
            rec.setValue({ fieldId: RFC.MARKETING_RATE, value: src.marketingRate });
            rec.setValue({ fieldId: RFC.FRANCHISE_AMOUNT, value: franchiseAmount });
            rec.setValue({ fieldId: RFC.MARKETING_AMOUNT, value: marketingAmount });

            const newId = rec.save({ ignoreMandatoryFields: false });
            log.debug('RFC created', 'id=' + newId + ' customer=' + customerId +
                (shopId ? ' shop=' + shopId : '') +
                ' revenue=' + revenue +
                ' rate=' + src.contractRate + '% franchise=' + franchiseAmount +
                ' mkt=' + src.marketingRate + '% marketing=' + marketingAmount);
            return newId;
        };

        /**
         * Re-submit this deployment so processing continues in a new execution.
         * The run date is passed on so a continuation that starts after midnight
         * still processes the original date.
         * @param {runtime.Script} script
         * @param {Date} runDate
         */
        const reschedule = (script, runDate) => {
            try {
                const params = {};
                params[PARAM_TODAY_IS] = format.format({ value: runDate, type: format.Type.DATE });
                const t = task.create({
                    taskType: task.TaskType.SCHEDULED_SCRIPT,
                    scriptId: script.id,
                    deploymentId: script.deploymentId,
                    params: params
                });
                const taskId = t.submit();
                log.audit('RFC rescheduled', 'task ' + taskId);
            } catch (e) {
                log.error('RFC reschedule failed', e);
            }
        };

        /** "1,234.50" -> 1234.5 ; null -> 0 */
        const toNumber = (v) => {
            if (v === null || v === undefined || v === '') {
                return 0;
            }
            const n = parseFloat(String(v).replace(/,/g, ''));
            return isNaN(n) ? 0 : n;
        };

        /** "12.5%" -> 12.5 ; 12.5 -> 12.5 ; null -> 0 */
        const toPercent = (v) => {
            if (v === null || v === undefined) {
                return 0;
            }
            return toNumber(String(v).replace('%', ''));
        };

        /** true / 'T' -> true ; anything else -> false */
        const toBool = (v) => v === true || v === 'T';

        /** 1 Nov 2026 -> "011126" */
        const toDdMmYy = (d) => [d.getDate(), d.getMonth() + 1, d.getFullYear() % 100]
            .map(n => String(n).padStart(2, '0')).join('');

        const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

        return { execute: execute };
    });
