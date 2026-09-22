========================================================
 TEXPARK PRO - BUSINESS MANAGER v2.0.0
========================================================

Ki notun (v1 theke ki thik hoyeche)
----------------------------------

1. STOCK MINUS SOMOSSA THIK HOYECHE  <-- apnar bola main problem
   Age: stock na thakleo memo save hoto, ar available stock
        minus (-) hoye jeto.
   Ekhon: stock japt na thakle memo save-i hobe na. Ki ki kom
          shetar list dekhabe. Chailে Settings theke negative
          stock onumoti dite paren.

2. PROFIT / LABH  <-- apnar bola ei ta chilo na
   Prottek product-er Cost Price track hoy. Memo save korar
   somoye-i per-item profit, COGS ar margin dekhа jay.
   Dashboard-e today/month profit, chart shoho.

3. SUPPLIER + PURCHASE
   Supplier list, purchase entry, purchase due, purchase return.
   Purchase korle stock barbe ar weighted-average cost update hobe.

4. KARCHA (EXPENSE) + REAL P&L
   Rent/salary/utility entry. Gross profit - kharcha = NET PROFIT.
   Month-wise P&L report.

5. PARTY LEDGER + DUE AGEING
   Customer-wise statement, 0-30/31-60/61-90/91-120/120+ buckets.
   Supplier-wise payable report.

6. LOGIN + ROLE
   Admin / Manager / Salesman / Accountant. Role onujayi menu
   kom-beshi hobe. Prottek user-er alada password.

7. STOCK LEDGER (audit trail)
   Prottek stock movement-er record - ke kokhon ki korlo,
   balance koto chilo. Kichui ar silently hariye jabe na.

8. SYNC THIK HOYECHE
   Age: "✓ Sync request sent" dekhато, kintu save hoyeche kina
        jane na (no-cors mode). Fail korleo "✓" dekhаto.
   Ekhon: response pore verify kore. Fail hole retry queue te
          jay, internet firlo automatic pathay. Badge-e dekhbe:
          "All synced" / "3 pending" / "2 failed".

9. ARO
   - Auto snapshot (prottek save-er age backup, ek click-e ferot)
   - Memo te driver/vehicle/receiver info + delivery tracking
   - Barcode-ready product SKU, VAT %, reorder level
   - Payment receive (Cash/bKash/Nagad/Bank/Cheque)
   - CSV export (memo, stock ledger, all data)


Install kivabe
--------------
1. Node.js LTS install korun (https://nodejs.org) - jodi na thake
2. START_APP.bat double click korun. Prothom bar package install hobe.
3. Desktop shortcut chailে CREATE_DESKTOP_SHORTCUT.bat chalান.
4. .exe banate chailে: npm run dist


Prothom login
-------------
  Username: admin
  Password: admin123

*** Login korar por por-i Settings > Change my password theke
    password bodle nin. ***


Purono data asha
----------------
Purono app-er data muchhe fela hoy ni. Notun app-e:
  Backup / Data > "Import old data" click korun.
Purono product, customer, stock o memo notun app-e chole ashbe.

Bujhe nin: purono memo-te cost price chilo na, tai sei purono
memo gulor profit 0 dekhabe. Notun memo theke profit thik
hishab hobe.


Google Sheets sync
------------------
1. Code.gs file ta apnar Google Apps Script project-e replace korun
2. Deploy > Manage deployments > Edit > NEW VERSION > Deploy
3. Same /exec URL ta app-er Settings-e bosান
4. Settings-e "Test Sync" chap diye verify korun - ekhon sotti
   response ashbe, tai kaj korche kina nিশ্চinte jante parben


Test chalate
------------
  npm test

Ei test ta asol business logic check kore - stock validation,
profit hishab, COGS, ageing, P&L. 42 ta check ache.


Guruttopurno
------------
- Purono app folder delete korben na.
- Notun app-er data key: texpark_pro_v2 (purono: texpark_biz_v1)
  Dui key-i alada thake, tai kichui mix hobe na.
