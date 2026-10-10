# TC_EXT_001–009 — Cypress QA staging

Spec: cypress/e2e/tc_ext/tc_ext_001_009.cy.js

Run in PowerShell:
```powershell
cd D:\POS_SYSTEM_QA
git fetch origin
git pull --ff-only origin ONLY_TESTING
cd qa\automation\Testing_POS
npm install
$env:CYPRESS_POS_BASE_URL = 'http://160.191.47.17'
$env:CYPRESS_POS_USERNAME = Read-Host 'QA username'
$env:CYPRESS_POS_PASSWORD = Read-Host 'QA password'
npx cypress run --spec 'cypress/e2e/tc_ext/tc_ext_001_009.cy.js'
```

Mutation disabled by default; enable only for permitted staging data: `$env:CYPRESS_EXT_RUN_MUTATIONS='true'`.

Fixtures via CYPRESS_ prefix: EXT_AVAILABLE_TABLE_ID, EXT_INACTIVE_CATEGORY_ID, EXT_CATEGORY_ID, EXT_CATEGORY_MENU_ITEM_ID, EXT_PRICE_MENU_ITEM_ID, EXT_OLD_ORDER_ID, EXT_NEW_ORDER_ID, EXT_NEW_PRICE, EXT_ORDER_ID, EXT_UNAVAILABLE_ITEM_ID, EXT_SELLABLE_ITEM_ID.

CAUTION: Mutation cases require real isolated fixtures. EXT_001 opens a session and does not automatically clean it; run validated QA recovery afterwards. EXT_004 changes a category persistently. EXT_005 needs an old order before price change and a new order with an item after price change, not simply two preexisting orders. EXT_007/008 should ideally have separate new orders. A pending test is NOT PASS. Do not commit tokens or credentials.