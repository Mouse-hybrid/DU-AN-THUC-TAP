# DES-QA-05 read-only Preflight

The checks read business data with `GET`; login uses `POST /auth/login` only to obtain a JWT. PF-01 checks `/health`; PF-02 reads available menu items and counts station IDs; PF-03 reads Kitchen Queue; PF-04 reads an isolated QA order with a `SERVED` item. PF-11/12 check the orders list route. PF-13/14 check the protected Kitchen Stations route and live OpenAPI contract without a JWT. A Passed Preflight is not a Passed result for any of the 25 DES05 functional testcases. Staging currently seeds two stations; PF-02 can Pass with mapped items without claiming six-station routing works.

## Run from PowerShell

First verify the staging seed password without running the business preflight:

```powershell
cd D:\POS_SYSTEM_QA
git switch ONLY_TESTING
git pull --ff-only origin ONLY_TESTING
cd qa\automation\Testing_POS
.\scripts\des05_check_staging_auth.ps1
```

This asks for the one shared staging seed password, sends the documented login payload for `supervisor`, `kitchen`, `cashier`, and `waiter`, and writes only the four HTTP statuses and `/version` short commit to `evidence/DES-QA-05/AUTH_<timestamp>.log`. It does not print the password, JWT or response body. HTTP 401 for all four accounts does not establish an API defect; BE should verify the effective `SEED_PASSWORD` and whether both accounts exist in staging. If all four return 200, run the preflight below using the same password.

```powershell
npm ci
.\scripts\des05_run_authenticated_preflight.ps1
```

The script prompts once for the common seeded password and checks `supervisor` and `kitchen` login first. If either login is not HTTP 200, it records only the HTTP statuses and does not start Cypress. With valid staging credentials it runs PF-01–04 and PF-11–12 in one Cypress invocation, writes the Terminal output to `evidence/DES-QA-05/PF-02_03_12_<timestamp>.log`, then clears the environment variables it used even if Cypress fails. `PF-04` stays Pending until an isolated QA order ID exists. If you have one, run `.\scripts\des05_run_authenticated_preflight.ps1 -OrderId '<QA_ORDER_UUID>'` to read it with the seeded supervisor account. The script does not reset staging or mutate order data. Check the log for sensitive data before committing it to GitHub. The catalog and Postman collection do not contain the staging password; obtain the current value from BE through a private channel.

For CI or manual runs, configure the following variables only in the runner or local PowerShell session. Never commit JWTs or passwords:

| Cypress environment variable | Purpose |
| --- | --- |
| `CYPRESS_DES05_MENU_TOKEN` | Optional token when Menu requires authentication |
| `CYPRESS_POS_USERNAME`, `CYPRESS_POS_PASSWORD` | Seeded supervisor login for PF-02 and PF-12 |
| `CYPRESS_EXT_KITCHEN_TOKEN` | Kitchen JWT for PF-03 |
| `CYPRESS_EXT_KITCHEN_USERNAME`, `CYPRESS_EXT_KITCHEN_PASSWORD` | Seeded kitchen login for PF-03 |
| `CYPRESS_EXT_REFIRE_SUPERVISOR_TOKEN` | Supervisor JWT for PF-04 |
| `CYPRESS_EXT_REFIRE_ORDER_ID` | Isolated QA Order UUID for PF-04 |

Missing credentials or fixtures produce `Pending` for the affected check. HTTP 401/403 with a configured token or an unexpected response shape produces `Failing` for Preflight investigation. Connection errors indicate reachability from the runner and do not, by themselves, establish a backend defect.

Record the run date, environment, PF-01–04/PF-11–14 results, HTTP codes, and evidence link in `Preflight Audit` and `Execution Start`. Keep the 25 business testcases `Blocked` until their own steps and assertions run with isolated data and cleanup. Confirm station names/IDs and menu mapping with BE/BA before routing execution; PF-02 only counts candidate station IDs.
