/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * Pret - Royalty Fees Calculation
 * ----------------------------------------------------------------------------
 * Runs daily. For every customer returned by the saved search
 * 'customsearch_pret_rfc_customers' it creates one
 * 'customrecord_pret_franchise_rfc' record holding the franchisee's revenue,
 * contract rate, marketing rate and the two calculated amounts.
 *
 * Revenue and the two rates are read directly from the saved search results.
 * The saved search must therefore include these customer fields as columns:
 *   custentity_pret_revenue_for_rfc_monthly
 *   custentity_pret_contract_rate_percent
 *   custentity_pret_contract_marketing_fee
 * The script checks for them on start and fails with a clear error if missing.
 *
 * Script parameter:
 *   custscript_pret_rfc_today_is (Date, optional)
 *     Date written to the RFC record. Leave empty on the production deployment
 *     so the script uses the real "today"; set it on a test deployment to
 *     simulate a specific run date.
 *
 * Idempotency: a franchisee that already has an RFC record for the run date is
 * skipped, so the script can be re-run (or rescheduled) safely.
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
            MARKETING_RATE: 'custentity_pret_contract_marketing_fee'
        };

        // Custom record fields (Docs/Fields.xlsx - sheet "CR")
        const RFC = {
            DATE: 'custrecord_pret_rfc_date',
            FRANCHISEE: 'custrecord_pret_franchisee',
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

            const customers = getCustomersFromSavedSearch();
            log.audit('RFC customers', 'Saved search returned ' + customers.length + ' customer(s)');
            if (!customers.length) {
                return;
            }

            const alreadyDone = getFranchiseesWithRecordOnDate(runDate);
            const pending = customers.filter(c => !alreadyDone.has(c.id));
            log.audit('RFC pending', pending.length + ' to process, ' + alreadyDone.size + ' already have a record for this date');
            if (!pending.length) {
                return;
            }

            const stats = { created: 0, errors: 0 };

            for (const cust of pending) {
                if (script.getRemainingUsage() < MIN_REMAINING_USAGE) {
                    log.audit('RFC governance', 'Low usage - rescheduling. Progress: ' + JSON.stringify(stats));
                    reschedule(script);
                    return;
                }
                try {
                    createRfcRecord(cust, runDate);
                    stats.created++;
                } catch (e) {
                    stats.errors++;
                    log.error('RFC create failed - customer ' + cust.id, e);
                }
            }

            log.audit('RFC done', JSON.stringify(stats));
        };

        /**
         * Resolve the run date from the 'today is' parameter, falling back to today.
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
                d = new Date();
            }
            // Normalise to midnight so comparisons on the date field are stable.
            return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        };

        /**
         * Read customers and their revenue / rates from the saved search.
         * One entry per customer (duplicates from joined columns are dropped).
         * @returns {{id:string, revenue:number, contractRate:number, marketingRate:number}[]}
         */
        const getCustomersFromSavedSearch = () => {
            const srch = search.load({ id: SAVED_SEARCH_ID });
            assertSearchColumns(srch);

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
                        marketingRate: toPercent(row.getValue({ name: CUST.MARKETING_RATE }))
                    });
                });
            });
            return out;
        };

        /**
         * Fail fast if the saved search no longer exposes the fields we need.
         * @param {search.Search} srch
         */
        const assertSearchColumns = (srch) => {
            const names = srch.columns.map(c => (typeof c === 'string' ? c : c.name).toLowerCase());
            const missing = [CUST.REVENUE, CUST.CONTRACT_RATE, CUST.MARKETING_RATE]
                .filter(f => names.indexOf(f) === -1);
            if (missing.length) {
                throw new Error('Saved search ' + SAVED_SEARCH_ID +
                    ' is missing required column(s): ' + missing.join(', '));
            }
        };

        /**
         * Franchisees that already have an RFC record dated runDate.
         * @param {Date} runDate
         * @returns {Set<string>}
         */
        const getFranchiseesWithRecordOnDate = (runDate) => {
            const done = new Set();
            const dateStr = format.format({ value: runDate, type: format.Type.DATE });
            search.create({
                type: RFC_RECORD_TYPE,
                filters: [
                    [RFC.DATE, 'on', dateStr], 'AND',
                    ['isinactive', 'is', 'F']
                ],
                columns: [RFC.FRANCHISEE]
            }).run().each(row => {
                const fr = row.getValue(RFC.FRANCHISEE);
                if (fr) {
                    done.add(String(fr));
                }
                return true;
            });
            return done;
        };

        /**
         * Create one RFC record for a franchisee.
         * @param {{id:string, revenue:number, contractRate:number, marketingRate:number}} cust
         * @param {Date} runDate
         * @returns {number} new record id
         */
        const createRfcRecord = (cust, runDate) => {
            const franchiseAmount = round2(cust.revenue * cust.contractRate / 100);
            const marketingAmount = round2(cust.revenue * cust.marketingRate / 100);

            const rec = record.create({ type: RFC_RECORD_TYPE, isDynamic: false });
            rec.setValue({ fieldId: RFC.DATE, value: runDate });
            rec.setValue({ fieldId: RFC.FRANCHISEE, value: cust.id });
            rec.setValue({ fieldId: RFC.REVENUE, value: cust.revenue });
            rec.setValue({ fieldId: RFC.CONTRACT_RATE, value: cust.contractRate });
            rec.setValue({ fieldId: RFC.MARKETING_RATE, value: cust.marketingRate });
            rec.setValue({ fieldId: RFC.FRANCHISE_AMOUNT, value: franchiseAmount });
            rec.setValue({ fieldId: RFC.MARKETING_AMOUNT, value: marketingAmount });

            const newId = rec.save({ ignoreMandatoryFields: false });
            log.debug('RFC created', 'id=' + newId + ' customer=' + cust.id +
                ' revenue=' + cust.revenue +
                ' rate=' + cust.contractRate + '% franchise=' + franchiseAmount +
                ' mkt=' + cust.marketingRate + '% marketing=' + marketingAmount);
            return newId;
        };

        /**
         * Re-submit this deployment so processing continues in a new execution.
         * @param {runtime.Script} script
         */
        const reschedule = (script) => {
            try {
                const params = {};
                params[PARAM_TODAY_IS] = script.getParameter({ name: PARAM_TODAY_IS });
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

        const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

        return { execute: execute };
    });
