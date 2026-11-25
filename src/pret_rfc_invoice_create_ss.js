/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Pret - RFC Invoice Create
 * ----------------------------------------------------------------------------
 * Created 11/2026 by NS Nexus ltd on behalf of Pret a Manger(Europe)Limited.
 *
 * Version: 1.3
 *
 * Version history:
 *   1.0  Initial version - one invoice per standard (Single Invoice = F)
 *        customer from its RFC record created on the run date.
 *   1.1  Source is the most recent RFC record with an empty Invoice Reference
 *        (no date filter, 'Today is' parameter removed); the new invoice's
 *        tranid is written back to the RFC record's Invoice Reference.
 *   1.2  Step-by-step audit logs for every invoice ("RFC <id> | <step>");
 *        errors name the step that failed. Transaction Reference Date line
 *        field: custcol_pret_tran_reference_date.
 *   1.3  Line 4 (Coffee Subscription Marketing Fee) description shows the
 *        Coffee Subscription Marketing Rate (custrecord_pret_coffee_subscription_mr)
 *        instead of the contract marketing rate.
 * ----------------------------------------------------------------------------
 * Creates customer invoices from the RFC records (customrecord_pret_franchise_rfc)
 * written by the Royalty Fees Calculation script (pret_rfc_calculate_fees_ss.js).
 *
 * Deploy daily, scheduled AFTER the calculation script. On most days there are
 * no uninvoiced RFC records and the script ends straight away; on the day after
 * an accounting period ends it invoices the records the calculation script has
 * just created.
 *
 * Customers: only those returned by saved search 'customsearch_pret_rfc_customers'
 * with Single Invoice (custentity_pret_single_invoice) = F. Single-invoice
 * customers are not handled yet.
 *
 * Source RFC record: per customer, the most recent RFC record (highest internal
 * id) whose Invoice Reference (custrecord_pret_rfc_invoice_reference) is empty.
 *
 * Invoice body:
 *   Customer      custrecord_pret_franchisee
 *   Subsidiary    customer's subsidiary
 *   Date          custrecord_pret_rfc_acc_period_ed
 *   Order #       "<period> Franchise Royalty /Marketing Fees"
 *                 e.g. "P11 2026 Franchise Royalty /Marketing Fees"
 *
 * Invoice lines (quantity 1, rate = amount; Transaction Reference Date =
 * period end date). Description: "<label> <period> - <rate>% <start> - <end>",
 * e.g. "Franchise Royalty Fees P11 2026 - 4.5% 30/10/2026 - 26/11/2026".
 *   1  Item 1067   Franchise Royalty Fees             custrecord_pret_contract_rate_percent / custrecord_pret_franchise_amount
 *   2  Item 11577  Franchise Marketing Fees           custrecord_pret_marketing_rate        / custrecord_pret_marketing_amount
 *   3  Item 1067   Franchise Coffee Subscription Fees custrecord_pret_coffee_subs_rate      / custrecord_pret_coffee_subs_amount
 *   4  Item 11577  Coffee Subscription Marketing Fee  custrecord_pret_coffee_subscription_mr / custrecord_pret_coffee_subscription_ma
 * Lines with a zero amount are left off; if all four are zero no invoice is
 * created.
 *
 * After the invoice is saved its number (tranid, e.g. "INV001234") is written
 * to the RFC record's Invoice Reference, so a re-run (or reschedule) never
 * invoices the same record twice. If Invoice Reference is a List/Record
 * (Transaction) field, the invoice internal id is written instead - that is
 * the only value such a field accepts, and NetSuite displays it as the
 * invoice number.
 *
 * No script parameters.
 */
define(['N/search', 'N/record', 'N/runtime', 'N/task', 'N/log', 'N/format'],
    (search, record, runtime, task, log, format) => {

        const SAVED_SEARCH_ID = 'customsearch_pret_rfc_customers';
        const RFC_RECORD_TYPE = 'customrecord_pret_franchise_rfc';

        const CUST = {
            SINGLE_INVOICE: 'custentity_pret_single_invoice',
            SUBSIDIARY: 'subsidiary'
        };

        // Custom record fields
        const RFC = {
            DATE: 'custrecord_pret_rfc_date',
            ACC_PERIOD: 'custrecord_pret_rfc_accounting_period',
            ACC_PERIOD_START: 'custrecord_pret_rfc_acc_period_sd',
            ACC_PERIOD_END: 'custrecord_pret_rfc_acc_period_ed',
            FRANCHISEE: 'custrecord_pret_franchisee',
            SHOP_NUMBER: 'custrecord_pret_shop_number_department',
            CONTRACT_RATE: 'custrecord_pret_contract_rate_percent',
            MARKETING_RATE: 'custrecord_pret_marketing_rate',
            FRANCHISE_AMOUNT: 'custrecord_pret_franchise_amount',
            MARKETING_AMOUNT: 'custrecord_pret_marketing_amount',
            COFFEE_RATE: 'custrecord_pret_coffee_subs_rate',
            COFFEE_AMOUNT: 'custrecord_pret_coffee_subs_amount',
            COFFEE_MKT_RATE: 'custrecord_pret_coffee_subscription_mr',
            COFFEE_MKT_AMOUNT: 'custrecord_pret_coffee_subscription_ma',
            INVOICE_REF: 'custrecord_pret_rfc_invoice_reference'
        };

        const ITEM = {
            ROYALTY: '1067',     // Franchise Royalty Fees
            MARKETING: '11577'   // Franchise Marketing Fee
        };

        // Invoice line column "Transaction Reference Date".
        const LINE_REF_DATE = 'custcol_pret_tran_reference_date';

        const ORDER_NO_SUFFIX = 'Franchise Royalty /Marketing Fees';

        // Invoice save ~ 30 units + RFC update; keep a margin for one more customer.
        const MIN_REMAINING_USAGE = 200;

        /**
         * Entry point.
         */
        const execute = () => {
            const script = runtime.getCurrentScript();
            log.audit('RFC INV start', 'Deployment ' + script.deploymentId);

            const customers = getStandardCustomers();
            audit('RFC INV customers', customers.size + ' standard (single invoice = F) customer(s) in saved search: ' +
                Array.from(customers.entries()).map(([id, c]) => id + ' (subsidiary ' + (c.subsidiary || '-') + ')').join(', '));
            if (!customers.size) {
                return;
            }

            const rfcs = getUninvoicedRfcRecords(customers);
            audit('RFC INV pending', rfcs.length + ' RFC record(s) to invoice: ' +
                rfcs.map(r => 'RFC ' + r.id + ' / customer ' + r.franchisee).join(', '));
            if (!rfcs.length) {
                return;
            }

            const stats = { invoiced: 0, skippedZero: 0, errors: 0 };
            for (const rfc of rfcs) {
                if (script.getRemainingUsage() < MIN_REMAINING_USAGE) {
                    log.audit('RFC INV governance', 'Low usage - rescheduling. Progress: ' + JSON.stringify(stats));
                    reschedule(script);
                    return;
                }
                let invoiceId = null;
                try {
                    invoiceId = createInvoice(rfc, customers.get(rfc.franchisee));
                    if (!invoiceId) {
                        stats.skippedZero++;
                        continue;
                    }
                    stats.invoiced++;
                    writeInvoiceReference(rfc.id, invoiceId);
                } catch (e) {
                    log.error('RFC INV error detail - RFC ' + rfc.id, JSON.stringify({
                        name: e.name, message: e.message, id: e.id, stack: e.stack
                    }).substring(0, 3999));
                    if (invoiceId) {
                        // Invoice exists but the RFC record still looks uninvoiced:
                        // fix by hand or the next run will invoice it again.
                        log.error('RFC INV reference NOT written - RFC ' + rfc.id + ' invoice ' + invoiceId +
                            ' - set ' + RFC.INVOICE_REF + ' manually', e);
                    }
                    stats.errors++;
                    log.error('RFC INV failed - RFC ' + rfc.id + ' customer ' + rfc.franchisee, e);
                }
            }

            log.audit('RFC INV done', JSON.stringify(stats));
        };

        /**
         * Customers from the saved search with Single Invoice = F.
         * @returns {Map<string, {subsidiary:string}>} customer id -> data
         */
        const getStandardCustomers = () => {
            const srch = search.load({ id: SAVED_SEARCH_ID });
            const names = srch.columns.map(c => (typeof c === 'string' ? c : c.name).toLowerCase());
            const extra = [CUST.SINGLE_INVOICE, CUST.SUBSIDIARY]
                .filter(f => names.indexOf(f) === -1)
                .map(f => search.createColumn({ name: f }));
            if (extra.length) {
                srch.columns = srch.columns.concat(extra);
            }

            const out = new Map();
            const paged = srch.runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach(range => {
                paged.fetch({ index: range.index }).data.forEach(row => {
                    const id = String(row.id);
                    if (out.has(id) || toBool(row.getValue({ name: CUST.SINGLE_INVOICE }))) {
                        return;
                    }
                    out.set(id, { subsidiary: row.getValue({ name: CUST.SUBSIDIARY }) });
                });
            });
            return out;
        };

        /**
         * Write the invoice number (tranid) of the new invoice to the RFC
         * record's Invoice Reference.
         * If the field is a List/Record (Transaction) field it can only hold the
         * invoice's internal id - NetSuite then displays it as the invoice
         * number - so the internal id is written in that case.
         * @param {string} rfcId
         * @param {number} invoiceId
         */
        const writeInvoiceReference = (rfcId, invoiceId) => {
            const tag = 'RFC ' + rfcId;
            const tranId = search.lookupFields({
                type: search.Type.INVOICE,
                id: invoiceId,
                columns: ['tranid']
            }).tranid;
            const value = isInvoiceRefSelectField() ? invoiceId : tranId;
            audit(tag + ' | 11 Write invoice reference', 'invoice id=' + invoiceId + ' tranid=' + tranId +
                ' -> ' + RFC.INVOICE_REF + '=' + value);
            record.submitFields({
                type: RFC_RECORD_TYPE,
                id: rfcId,
                values: { [RFC.INVOICE_REF]: value },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
            audit(tag + ' | 12 Done', 'RFC record updated with invoice ' + tranId);
        };

        /** True when Invoice Reference is a List/Record field (checked once per execution). */
        let invoiceRefIsSelect = null;
        const isInvoiceRefSelectField = () => {
            if (invoiceRefIsSelect === null) {
                const field = record.create({ type: RFC_RECORD_TYPE }).getField({ fieldId: RFC.INVOICE_REF });
                invoiceRefIsSelect = !!field && field.type === 'select';
                log.audit('RFC INV reference field', RFC.INVOICE_REF + ' type=' + (field ? field.type : 'not found') +
                    ' -> writing ' + (invoiceRefIsSelect ? 'invoice internal id' : 'invoice tranid'));
            }
            return invoiceRefIsSelect;
        };

        /**
         * Most recent RFC record (highest internal id) per customer whose
         * Invoice Reference is empty.
         * Records with a shop number belong to single-invoice customers and are ignored.
         * @param {Map<string, Object>} customers allowed franchisees
         * @returns {Object[]}
         */
        const getUninvoicedRfcRecords = (customers) => {
            const latest = new Map();
            const paged = search.create({
                type: RFC_RECORD_TYPE,
                filters: [
                    isInvoiceRefSelectField()
                        ? [RFC.INVOICE_REF, 'anyof', '@NONE@']
                        : [RFC.INVOICE_REF, 'isempty', ''], 'AND',
                    [RFC.SHOP_NUMBER, 'isempty', ''], 'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'internalid', sort: search.Sort.DESC }),
                    RFC.FRANCHISEE, RFC.ACC_PERIOD, RFC.ACC_PERIOD_START, RFC.ACC_PERIOD_END,
                    RFC.CONTRACT_RATE, RFC.MARKETING_RATE, RFC.FRANCHISE_AMOUNT, RFC.MARKETING_AMOUNT,
                    RFC.COFFEE_RATE, RFC.COFFEE_AMOUNT, RFC.COFFEE_MKT_RATE, RFC.COFFEE_MKT_AMOUNT
                ]
            }).runPaged({ pageSize: 1000 });

            paged.pageRanges.forEach(range => {
                paged.fetch({ index: range.index }).data.forEach(row => {
                    const fr = String(row.getValue({ name: RFC.FRANCHISEE }) || '');
                    // Sorted newest first: the first record seen per customer is the most recent.
                    if (!fr || !customers.has(fr) || latest.has(fr)) {
                        return;
                    }
                    const v = (name) => row.getValue({ name: name });
                    latest.set(fr, {
                        id: String(row.id),
                        franchisee: fr,
                        period: v(RFC.ACC_PERIOD),
                        periodStart: toDate(v(RFC.ACC_PERIOD_START)),
                        periodEnd: toDate(v(RFC.ACC_PERIOD_END)),
                        contractRate: toPercent(v(RFC.CONTRACT_RATE)),
                        marketingRate: toPercent(v(RFC.MARKETING_RATE)),
                        franchiseAmount: toNumber(v(RFC.FRANCHISE_AMOUNT)),
                        marketingAmount: toNumber(v(RFC.MARKETING_AMOUNT)),
                        coffeeRate: toPercent(v(RFC.COFFEE_RATE)),
                        coffeeAmount: toNumber(v(RFC.COFFEE_AMOUNT)),
                        coffeeMktRate: toPercent(v(RFC.COFFEE_MKT_RATE)),
                        coffeeMktAmount: toNumber(v(RFC.COFFEE_MKT_AMOUNT))
                    });
                });
            });
            return Array.from(latest.values());
        };

        /**
         * Create the invoice for one RFC record.
         * @param {Object} rfc
         * @param {{subsidiary:string}} cust
         * @returns {number|null} invoice id, or null when every line is zero
         */
        const createInvoice = (rfc, cust) => {
            const tag = 'RFC ' + rfc.id;
            let stepName = '';
            /** Audit-log one step; the step name is added to any error thrown afterwards. */
            const step = (name, detail) => {
                stepName = name;
                audit(tag + ' | ' + name, detail);
            };

            try {
                step('1 Source RFC record', rfc);
                if (!rfc.periodEnd || !rfc.periodStart || !rfc.period) {
                    throw new Error('RFC record ' + rfc.id + ' has no accounting period / start / end date');
                }

                const lines = [
                    { no: 1, item: ITEM.ROYALTY, label: 'Franchise Royalty Fees', rate: rfc.contractRate, amount: rfc.franchiseAmount },
                    { no: 2, item: ITEM.MARKETING, label: 'Franchise Marketing Fees', rate: rfc.marketingRate, amount: rfc.marketingAmount },
                    { no: 3, item: ITEM.ROYALTY, label: 'Franchise Coffee Subscription Fees', rate: rfc.coffeeRate, amount: rfc.coffeeAmount },
                    { no: 4, item: ITEM.MARKETING, label: 'Coffee Subscription Marketing Fee', rate: rfc.coffeeMktRate, amount: rfc.coffeeMktAmount }
                ];
                const skipped = lines.filter(l => l.amount === 0).map(l => l.no + ' ' + l.label);
                const used = lines.filter(l => l.amount !== 0);
                step('2 Lines to invoice', used.length + ' line(s)' +
                    (skipped.length ? '; zero amount, left off: ' + skipped.join(', ') : ''));

                if (!used.length) {
                    audit(tag + ' | SKIPPED', 'Customer ' + rfc.franchisee + ' - all amounts are zero, no invoice created');
                    return null;
                }

                const dates = toDdMmYyyy(rfc.periodStart) + ' - ' + toDdMmYyyy(rfc.periodEnd);
                const orderNo = rfc.period + ' ' + ORDER_NO_SUFFIX;

                step('3 Create invoice record (dynamic)', 'type=' + record.Type.INVOICE);
                const inv = record.create({ type: record.Type.INVOICE, isDynamic: true });

                step('4 Set customer', 'entity=' + rfc.franchisee);
                inv.setValue({ fieldId: 'entity', value: rfc.franchisee });
                audit(tag + ' | 4 Customer set', {
                    customer: inv.getText({ fieldId: 'entity' }),
                    sourcedSubsidiary: inv.getText({ fieldId: 'subsidiary' }),
                    currency: inv.getText({ fieldId: 'currency' }),
                    terms: inv.getText({ fieldId: 'terms' }),
                    form: inv.getText({ fieldId: 'customform' })
                });

                if (cust && cust.subsidiary) {
                    step('5 Set subsidiary', 'subsidiary=' + cust.subsidiary);
                    inv.setValue({ fieldId: 'subsidiary', value: cust.subsidiary });
                } else {
                    step('5 Set subsidiary', 'no subsidiary from saved search - keeping the one sourced from the customer');
                }

                step('6 Set date', 'trandate=' + toDdMmYyyy(rfc.periodEnd));
                inv.setValue({ fieldId: 'trandate', value: rfc.periodEnd });

                step('7 Set Order #', 'otherrefnum="' + orderNo + '"');
                inv.setValue({ fieldId: 'otherrefnum', value: orderNo });

                audit(tag + ' | 7 Header done', {
                    subsidiary: inv.getText({ fieldId: 'subsidiary' }),
                    trandate: inv.getText({ fieldId: 'trandate' }),
                    postingperiod: inv.getText({ fieldId: 'postingperiod' }),
                    otherrefnum: inv.getValue({ fieldId: 'otherrefnum' })
                });

                for (const l of used) {
                    const p = '8.' + l.no + ' Line ' + l.no;
                    const description = l.label + ' ' + rfc.period + ' - ' + fmtRate(l.rate) + ' ' + dates;

                    step(p + ' select new line', '');
                    inv.selectNewLine({ sublistId: 'item' });

                    step(p + ' set item', 'item=' + l.item);
                    inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: l.item });

                    step(p + ' set description', description);
                    inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: description });

                    step(p + ' set quantity / rate / amount', 'quantity=1 rate=' + l.amount + ' amount=' + l.amount);
                    inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
                    inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: l.amount });
                    inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: l.amount });

                    if (inv.getCurrentSublistField({ sublistId: 'item', fieldId: LINE_REF_DATE })) {
                        step(p + ' set Transaction Reference Date', LINE_REF_DATE + '=' + toDdMmYyyy(rfc.periodEnd));
                        inv.setCurrentSublistValue({ sublistId: 'item', fieldId: LINE_REF_DATE, value: rfc.periodEnd });
                    } else {
                        log.error(tag + ' | ' + p + ' line field missing', 'Line field ' + LINE_REF_DATE +
                            ' (Transaction Reference Date) not found on the invoice form - not set');
                    }

                    // Read-back for the log only - never let it break the invoice.
                    const cur = (f) => {
                        try {
                            return inv.getCurrentSublistText({ sublistId: 'item', fieldId: f });
                        } catch (ignore) {
                            return '(n/a)';
                        }
                    };
                    step(p + ' commit line', {
                        item: cur('item'),
                        quantity: cur('quantity'),
                        rate: cur('rate'),
                        amount: cur('amount'),
                        taxcode: cur('taxcode'),
                        refDate: inv.getCurrentSublistField({ sublistId: 'item', fieldId: LINE_REF_DATE }) ? cur(LINE_REF_DATE) : '(no field)'
                    });
                    inv.commitLine({ sublistId: 'item' });
                }

                step('9 Save invoice', {
                    lines: inv.getLineCount({ sublistId: 'item' }),
                    subtotal: inv.getValue({ fieldId: 'subtotal' }),
                    tax: inv.getValue({ fieldId: 'taxtotal' }),
                    total: inv.getValue({ fieldId: 'total' }),
                    remainingUsage: runtime.getCurrentScript().getRemainingUsage()
                });
                const id = inv.save({ enableSourcing: true, ignoreMandatoryFields: false });

                audit(tag + ' | 10 Invoice created', 'invoice internal id=' + id + ' customer=' + rfc.franchisee +
                    ' lines=' + used.length + ' total (excl. tax)=' + round2(used.reduce((s, l) => s + l.amount, 0)));
                return id;
            } catch (e) {
                const err = new Error('Failed at step "' + stepName + '": ' + (e.name ? e.name + ' - ' : '') + (e.message || e));
                err.name = e.name || 'RFC_INV_ERROR';
                throw err;
            }
        };

        /** Audit log, objects as JSON, cut to NetSuite's 3999-character detail limit. */
        const audit = (title, detail) => {
            const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
            log.audit({ title: title.substring(0, 99), details: (text || '').substring(0, 3999) });
        };

        /**
         * Re-submit this deployment so processing continues in a new execution.
         * Already-invoiced RFC records have a reference, so they are not picked up again.
         * @param {runtime.Script} script
         */
        const reschedule = (script) => {
            try {
                const taskId = task.create({
                    taskType: task.TaskType.SCHEDULED_SCRIPT,
                    scriptId: script.id,
                    deploymentId: script.deploymentId
                }).submit();
                log.audit('RFC INV rescheduled', 'task ' + taskId);
            } catch (e) {
                log.error('RFC INV reschedule failed', e);
            }
        };

        /** Search date string -> Date ; empty -> null */
        const toDate = (v) => (v ? format.parse({ value: v, type: format.Type.DATE }) : null);

        /** "1,234.50" -> 1234.5 ; null -> 0 */
        const toNumber = (v) => {
            if (v === null || v === undefined || v === '') {
                return 0;
            }
            const n = parseFloat(String(v).replace(/,/g, ''));
            return isNaN(n) ? 0 : n;
        };

        /** "12.5%" -> 12.5 ; null -> 0 */
        const toPercent = (v) => (v === null || v === undefined ? 0 : toNumber(String(v).replace('%', '')));

        /** true / 'T' -> true */
        const toBool = (v) => v === true || v === 'T';

        /** 4.5 -> "4.5%" ; 2 -> "2.0%" ; 4.25 -> "4.25%" */
        const fmtRate = (n) => (Number.isInteger(round2(n) * 10) ? n.toFixed(1) : String(round2(n))) + '%';

        /** 30 Oct 2026 -> "30/10/2026" */
        const toDdMmYyyy = (d) => String(d.getDate()).padStart(2, '0') + '/' +
            String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();

        const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

        return { execute: execute };
    });
