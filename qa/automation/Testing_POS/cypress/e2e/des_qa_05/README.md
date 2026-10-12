# DES-QA-05 read-only Preflight

This spec sends only `GET` requests. PF-01 checks `/health`; PF-02 inspects available menu station fixture candidates; PF-03 reads Kitchen Queue; PF-04 reads an isolated QA order with a `SERVED` item. A Passed Preflight is not a Passed result for any of the 25 DES05 functional testcases.

## Run from PowerShell

```powershell
cd D:\POS_SYSTEM_QA
git switch ONLY_TESTING
git pull --ff-only origin ONLY_TESTING
cd qa\automation\Testing_POS
npm ci
$env:CYPRESS_POS_BASE_URL = 'http://160.191.47.17'
npx cypress run --browser chrome --headless --spec 'cypress/e2e/des_qa_05/des_qa_05_kds_refire_readonly_preflight.cy.js'
```

For protected checks, configure the following variables only in your local PowerShell session or GitHub Actions secrets/variables. Never commit JWTs or passwords:

| Cypress environment variable | Purpose |
| --- | --- |
| `CYPRESS_DES05_MENU_TOKEN` | Optional token when Menu requires authentication |
| `CYPRESS_EXT_KITCHEN_TOKEN` | Kitchen JWT for PF-03 |
| `CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN` | Supervisor JWT for PF-04 |
| `CYPRESS_EXT_REFIRE_ORDER_ID` | Isolated QA Order UUID for PF-04 |

Missing credentials or fixtures produce `Pending` for the affected check. HTTP 401/403 with a configured token or an unexpected response shape produces `Failing` for Preflight investigation. Connection errors indicate reachability from the runner and do not, by themselves, establish a backend defect.

Record the run date, environment, PF-01..04 results, HTTP codes, and link to the Actions run in `Preflight Audit` and `Execution Start`. Keep the 25 business testcases `Not Executed` until their own steps and assertions run with approved isolated data and cleanup. Confirm station names/IDs and menu mapping with BE/BA before routing execution; PF-02 only counts candidate station IDs.
