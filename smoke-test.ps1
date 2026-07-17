$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$baseUrl = "http://localhost:3100"
$server = Start-Job -ScriptBlock {
  Set-Location $using:root
  $env:NODE_NO_WARNINGS = "1"
  $env:NODE_ENV = "test"
  $env:PORT = "3100"
  node server.js
}

function Get-Csrf($html) {
  $match = [regex]::Match($html, 'name="csrf" value="([^"]+)"')
  if (-not $match.Success) { throw "CSRF token not found" }
  return $match.Groups[1].Value
}

try {
  Start-Sleep -Milliseconds 900
  $web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $homeResponse = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/"
  if ($homeResponse.StatusCode -ne 200 -or $homeResponse.Content -notmatch 'data-carousel' -or $homeResponse.Content -notmatch "Leave a lasting first impression") { throw "Home page failed" }

  $register = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/register"
  $csrf = Get-Csrf $register.Content
  $email = "smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())@example.com"
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/register" -Body @{
    csrf = $csrf
    name = "Smoke Test"
    email = $email
    password = "Testing123!"
    next = "/account"
  } | Out-Null

  $productsPage = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/products"
  $slug = [regex]::Match($productsPage.Content, '<article class="product-card">\s*<a href="/product/([^"]+)"').Groups[1].Value
  if (-not $slug) { throw "No visible product found" }
  $product = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/product/$slug"
  $csrf = Get-Csrf $product.Content
  $productId = [regex]::Match($product.Content, 'name="product_id" value="(\d+)"').Groups[1].Value
  $productName = [regex]::Match($product.Content, '<h1>([^<]+)</h1>').Groups[1].Value
  if (-not $productId -or -not $productName) { throw "Product form details not found" }
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/cart/add" -Body @{
    csrf = $csrf
    product_id = $productId
    quantity = "100"
    size = "3.5 x 2 in"
    material = "Matte"
    print_option = "Double-sided"
    artwork_note = "Smoke test artwork"
  } | Out-Null

  $cart = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/cart"
  if ($cart.Content -notmatch [regex]::Escape($productName)) { throw "Cart persistence failed" }

  $checkout = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/checkout"
  $csrf = Get-Csrf $checkout.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/checkout" -Body @{
    csrf = $csrf
    customer_name = "Smoke Test"
    phone = "9876543210"
    address = "12 Test Street"
    city = "Bengaluru"
    postal_code = "560001"
    payment_method = "cod"
  } | Out-Null

  $orders = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/account/orders"
  if ($orders.Content -notmatch "PO-" -or $orders.Content -notmatch "Pending") { throw "Order creation failed" }
  $orderNumber = [regex]::Match($orders.Content, 'PO-\d{4}-\d{6}').Value
  if (-not $orderNumber) { throw "Order number not found" }

  $track = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/track"
  $csrf = Get-Csrf $track.Content
  $tracked = Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/track" -Body @{
    csrf = $csrf
    order_number = $orderNumber
    phone = "9876543210"
  }
  if ($tracked.Content -notmatch "Pending") { throw "Tracking failed" }

  $invoice = Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/invoice/$orderNumber"
  if ($invoice.Content -notmatch "GST INVOICE") { throw "Invoice failed" }

  $admin = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/login?next=/admin"
  $csrf = Get-Csrf $login.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/login" -Body @{
    csrf = $csrf
    email = "admin@printoasis.example"
    password = "PrintOasisAdmin123!"
    next = "/admin"
  } | Out-Null

  $dashboard = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin"
  if ($dashboard.Content -notmatch "Operations dashboard") { throw "Admin dashboard failed" }

  $adminProducts = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/products"
  $csrf = Get-Csrf $adminProducts.Content
  $productStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $smokeProductName = "Smoke Poster $productStamp"
  $smokeProductSlug = "smoke-poster-$productStamp"
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/admin/products/save" -Body @{
    csrf = $csrf
    name = $smokeProductName
    slug = $smokeProductSlug
    category = "marketing"
    price = "199"
    min_qty = "1"
    rating = "4.5"
    badge = "Smoke"
    description = "Temporary smoke-test product"
    sizes = "A4|A3"
    materials = "Matte"
    print_options = "Full color"
    color = "cobalt"
    stock = "10"
    status = "active"
  } | Out-Null
  $adminProducts = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/products"
  if ($adminProducts.Content -notmatch $smokeProductName) { throw "Admin product create failed" }
  $productId = [regex]::Match($adminProducts.Content, "admin/products\?edit=(\d+)[\s\S]{0,500}$smokeProductName").Groups[1].Value
  if (-not $productId) { $productId = [regex]::Match($adminProducts.Content, "$smokeProductName[\s\S]{0,500}admin/products\?edit=(\d+)").Groups[1].Value }
  if (-not $productId) { throw "Admin product id not found" }
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/admin/products/delete" -Body @{
    csrf = (Get-Csrf (Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/products").Content)
    id = $productId
  } | Out-Null

  $orderAdmin = Invoke-WebRequest -UseBasicParsing -WebSession $admin "$baseUrl/admin/orders"
  $orderId = [regex]::Match($orderAdmin.Content, 'name="order_id" value="(\d+)"').Groups[1].Value
  if (-not $orderId) { throw "Admin order id not found" }
  $csrf = Get-Csrf $orderAdmin.Content
  Invoke-WebRequest -UseBasicParsing -WebSession $admin -Method Post -Uri "$baseUrl/admin/orders/status" -Body @{
    csrf = $csrf
    order_id = $orderId
    status = "Shipped"
    tracking_number = "TRK123"
    note = "Smoke shipped"
  } | Out-Null
  $tracked = Invoke-WebRequest -UseBasicParsing -WebSession $web -Method Post -Uri "$baseUrl/track" -Body @{
    csrf = (Get-Csrf (Invoke-WebRequest -UseBasicParsing -WebSession $web "$baseUrl/track").Content)
    order_number = $orderNumber
    phone = "9876543210"
  }
  if ($tracked.Content -notmatch "Shipped" -or $tracked.Content -notmatch "TRK123") { throw "Admin status update failed" }

  Write-Output "PASS home=200 auth=registered cart=persisted checkout=created orders=visible admin=working tracking=working invoice=working"
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
}
