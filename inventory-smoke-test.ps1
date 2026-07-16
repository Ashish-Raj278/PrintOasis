$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$baseUrl = "http://localhost:3101"
$env:NODE_NO_WARNINGS = "1"

$server = Start-Job -ScriptBlock {
  Set-Location $using:root
  $env:NODE_NO_WARNINGS = "1"
  $env:NODE_ENV = "test"
  $env:PORT = "3101"
  node server.js
}

function Get-Csrf($html) {
  $match = [regex]::Match($html, 'name="csrf" value="([^"]+)"')
  if (-not $match.Success) { throw "CSRF token not found" }
  return $match.Groups[1].Value
}

function Get-Inventory($slug) {
  $json = node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('data/store.db'); const row=db.prepare('SELECT id,slug,stock,reserved FROM products WHERE slug=?').get(process.argv[1]); console.log(JSON.stringify(row));" $slug
  if (-not $json) { throw "Product $slug not found in database" }
  return $json | ConvertFrom-Json
}

function Get-OrderId($orderNumber) {
  $value = node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('data/store.db'); const row=db.prepare('SELECT id FROM orders WHERE order_number=?').get(process.argv[1]); console.log(row ? row.id : '');" $orderNumber
  if (-not $value) { throw "Order id not found for $orderNumber" }
  return $value
}

function Clear-InventorySmokeData {
  node scripts/cleanup-inventory-smoke.js
}

try {
  Start-Sleep -Milliseconds 900

  $admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $adminLogin = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/login?next=/admin"
  $csrf = Get-Csrf $adminLogin.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/login" -Body @{
    csrf = $csrf
    email = "admin@printoasis.example"
    password = "PrintOasisAdmin123!"
    next = "/admin"
  } | Out-Null

  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $slug = "inventory-smoke-$stamp"
  $name = "Inventory Smoke $stamp"
  $adminProducts = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/products"
  $csrf = Get-Csrf $adminProducts.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/admin/products/save" -Body @{
    csrf = $csrf
    name = $name
    slug = $slug
    category = "marketing"
    price = "200"
    min_qty = "1"
    rating = "4.5"
    badge = "Inventory"
    description = "Inventory smoke-test product"
    sizes = "A4"
    materials = "Matte"
    print_options = "Full color"
    color = "mint"
    stock = "2"
    status = "active"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 0) { throw "Initial inventory incorrect" }

  $web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $register = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/register"
  $csrf = Get-Csrf $register.Content
  $email = "inventory-$stamp@example.com"
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/register" -Body @{
    csrf = $csrf
    name = "Inventory Tester"
    email = $email
    password = "Testing123!"
    next = "/account"
  } | Out-Null

  $product = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/product/$slug"
  $csrf = Get-Csrf $product.Content
  $productId = [regex]::Match($product.Content, 'name="product_id" value="(\d+)"').Groups[1].Value
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/cart/add" -Body @{
    csrf = $csrf
    product_id = $productId
    quantity = "2"
    size = "A4"
    material = "Matte"
    print_option = "Full color"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 2) { throw "Add to cart should reserve 2 without reducing stock" }

  $product = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/product/$slug"
  $csrf = Get-Csrf $product.Content
  $reject = Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/cart/add" -Body @{
    csrf = $csrf
    product_id = $productId
    quantity = "1"
    size = "A4"
    material = "Matte"
    print_option = "Full color"
  }
  if ($reject.Content -notmatch "Only 0 items available" -and $reject.Content -notmatch "out of stock") { throw "Oversell rejection failed" }

  $cart = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/cart"
  $csrf = Get-Csrf $cart.Content
  $itemId = [regex]::Match($cart.Content, 'name="item_id" value="(\d+)"').Groups[1].Value
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/cart/update" -Body @{
    csrf = $csrf
    item_id = $itemId
    quantity = "1"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 1) { throw "Cart update should release 1 reserved item" }

  $checkout = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/checkout"
  $csrf = Get-Csrf $checkout.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/checkout" -Body @{
    csrf = $csrf
    customer_name = "Inventory Tester"
    phone = "9876500000"
    address = "1 Inventory Lane"
    city = "Bengaluru"
    postal_code = "560001"
    payment_method = "cod"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 1 -or $inventory.reserved -ne 0) { throw "Checkout should deduct stock and reserved by 1" }

  $orders = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/account/orders"
  $orderNumber = [regex]::Match($orders.Content, 'PO-\d{4}-\d{6}').Value
  $orderId = Get-OrderId $orderNumber
  $adminOrders = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/orders"
  $csrf = Get-Csrf $adminOrders.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/admin/orders/status" -Body @{
    csrf = $csrf
    order_id = $orderId
    status = "Cancelled"
    tracking_number = ""
    note = "Inventory smoke cancellation"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 0) { throw "Cancelled order should restore stock once" }

  $product = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/product/$slug"
  $csrf = Get-Csrf $product.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/cart/add" -Body @{
    csrf = $csrf
    product_id = $productId
    quantity = "1"
    size = "A4"
    material = "Matte"
    print_option = "Full color"
  } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 1) { throw "Second cart add should reserve 1" }

  $account = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/account"
  $csrf = Get-Csrf $account.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/logout" -Body @{ csrf = $csrf } | Out-Null

  $inventory = Get-Inventory $slug
  if ($inventory.stock -ne 2 -or $inventory.reserved -ne 0) { throw "Logout should release reserved inventory" }

  Write-Output "PASS inventory=reserved_without_stock_deduct update=released checkout=deducted cancel=restocked logout=released"
}
catch {
  if ($_.Exception.Response) {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output $reader.ReadToEnd()
  }
  throw
}
finally {
  if ($server) {
    Receive-Job $server -ErrorAction Continue
    Stop-Job $server
    Remove-Job $server
  }
  Clear-InventorySmokeData
}
