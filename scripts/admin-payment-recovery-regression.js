const assert = require("node:assert/strict");
const adminRoutes = require("../routes/admin");

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function fixture({ isAdmin = true, csrfValid = true, candidate = { provider_payment_id: "pay_recovery_123" } } = {}) {
  const calls = { reconcilePayments: [], reconcileRefunds: [], recover: [], candidateQueries: [], page: 0 };
  const response = { status: 0, body: "", headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { this.status = status; }, end(body) { this.body = String(body); } };
  const finalize = async () => "PO-TEST-123";
  const app = {
    requireAdmin() { return isAdmin; },
    validCsrf() { return csrfValid; },
    send(res, status, body) { res.writeHead(status); res.end(body); },
    redirect(res, location) { res.redirectedTo = location; },
    async adminPaymentRecoveryPage() { calls.page += 1; return "recovery page"; },
    reconcileProviderPayments: async options => { calls.reconcilePayments.push(options); return { checked: 2, updated: 1, webhook_events: 0, unresolved_provider_orders: 1 }; },
    reconcileRefunds: async options => { calls.reconcileRefunds.push(options); return { checked: 3, changed: 2, unresolved: 1 }; },
    finalizeCapturedCheckout: finalize,
    db: { async get(...args) { calls.candidateQueries.push(args); return candidate; } },
    async recoverCapturedCheckout(...args) { calls.recover.push(args); return { status: "order_created", order_number: "PO-TEST-123" }; }
  };
  const context = (pathname, data = {}, method = "POST") => ({
    req: { method }, res: response, url: new URL(`http://localhost${pathname}`), data,
    session: { csrf: "valid-token", user: { id: 7 } }, cart: {}, app
  });
  return { app, calls, response, context };
}

async function run() {
  {
    const f = fixture({ isAdmin: false });
    equal(await adminRoutes(f.context("/admin/payments/recovery/reconcile", { csrf: "valid-token" })), true, "Admin route handles the request.");
    equal(f.calls.reconcilePayments.length, 0, "A non-admin cannot trigger payment reconciliation.");
    equal(f.calls.reconcileRefunds.length, 0, "A non-admin cannot trigger refund reconciliation.");
  }
  {
    const f = fixture({ csrfValid: false });
    equal(await adminRoutes(f.context("/admin/payments/recovery/reconcile", { csrf: "bad-token" })), true, "Invalid-CSRF request is handled.");
    equal(f.response.status, 403, "Reconciliation requires valid CSRF.");
    equal(f.calls.reconcilePayments.length, 0, "Invalid CSRF cannot invoke payment reconciliation.");
    equal(f.calls.reconcileRefunds.length, 0, "Invalid CSRF cannot invoke refund reconciliation.");
  }
  {
    const f = fixture();
    await adminRoutes(f.context("/admin/payments/recovery/reconcile", { csrf: "valid-token" }));
    equal(f.calls.reconcilePayments.length, 1, "Admin reconciliation calls the existing payment reconciler once.");
    equal(f.calls.reconcileRefunds.length, 1, "Admin reconciliation calls the existing refund reconciler once.");
    equal(f.calls.reconcilePayments[0].limit, 50, "Payment reconciliation is explicitly bounded to 50 records.");
    equal(f.calls.reconcileRefunds[0].limit, 50, "Refund reconciliation is explicitly bounded to 50 records.");
    equal(f.calls.recover.length, 0, "Reconciliation never automatically recovers captured payments.");
    ok(decodeURIComponent(f.response.redirectedTo).includes("unresolved provider orders 1"), "Reconciliation reports unresolved provider orders.");
  }
  {
    const f = fixture({ isAdmin: false });
    await adminRoutes(f.context("/admin/payments/recovery/one", { csrf: "valid-token", provider_payment_id: "pay_recovery_123" }));
    equal(f.calls.recover.length, 0, "A non-admin cannot recover a payment.");
    equal(f.calls.candidateQueries.length, 0, "A non-admin cannot query recovery candidates through the action.");
  }
  {
    const f = fixture({ csrfValid: false });
    await adminRoutes(f.context("/admin/payments/recovery/one", { csrf: "bad-token", provider_payment_id: "pay_recovery_123" }));
    equal(f.response.status, 403, "Per-payment recovery requires valid CSRF.");
    equal(f.calls.recover.length, 0, "Invalid CSRF cannot invoke payment recovery.");
  }
  {
    const f = fixture();
    await adminRoutes(f.context("/admin/payments/recovery/one", { csrf: "valid-token", provider_payment_id: "pay_recovery_123" }));
    equal(f.calls.candidateQueries.length, 1, "Recovery checks the selected payment is still captured and has no order.");
    equal(f.calls.recover.length, 1, "The existing recovery function is called exactly once.");
    equal(f.calls.recover[0][0], "pay_recovery_123", "Recovery receives only the selected payment ID.");
    equal(f.calls.recover[0][1].finalize, f.app.finalizeCapturedCheckout, "Recovery reuses the existing order finalizer.");
    equal(f.calls.reconcilePayments.length, 0, "Per-payment recovery does not trigger another payment batch.");
    equal(f.calls.reconcileRefunds.length, 0, "Per-payment recovery does not trigger another refund batch.");
    ok(decodeURIComponent(f.response.redirectedTo).includes("Recovery result: order_created"), "The resulting recovery status is shown to the admin.");
  }
  {
    const f = fixture({ candidate: null });
    await adminRoutes(f.context("/admin/payments/recovery/one", { csrf: "valid-token", provider_payment_id: "pay_recovery_123" }));
    equal(f.calls.recover.length, 0, "A payment that is no longer a captured no-order candidate is not recovered.");
  }
  {
    const f = fixture();
    await adminRoutes(f.context("/admin/payments/recovery", {}, "GET"));
    equal(f.calls.page, 1, "The protected recovery page is routed through the existing admin page architecture.");
  }
  process.stdout.write(`Admin payment recovery regression: ${assertions} assertions passed.\n`);
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
