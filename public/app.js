const menuButton = document.querySelector(".menu-toggle");
const categoryNav = document.querySelector(".category-nav");
menuButton?.addEventListener("click", () => categoryNav?.classList.toggle("open"));

const savedTheme = localStorage.getItem("printoasis-theme");
if (savedTheme === "dark") document.documentElement.classList.add("dark-mode");
document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  document.documentElement.classList.toggle("dark-mode");
  localStorage.setItem("printoasis-theme", document.documentElement.classList.contains("dark-mode") ? "dark" : "light");
});

const searchInput = document.querySelector('.search input[name="q"]');
if (searchInput) {
  let list = document.querySelector("#search-suggestions");
  if (!list) {
    list = document.createElement("datalist");
    list.id = "search-suggestions";
    document.body.appendChild(list);
  }
  searchInput.setAttribute("list", "search-suggestions");
  searchInput.addEventListener("input", async () => {
    const query = searchInput.value.trim();
    if (query.length < 2) return;
    const response = await fetch(`/api/search-suggestions?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    list.innerHTML = data.suggestions.map(item => `<option value="${item.replaceAll('"', "&quot;")}"></option>`).join("");
  });
}

const quantity = document.querySelector('input[name="quantity"]');
const price = document.querySelector("[data-unit-price]");
if (quantity && price) {
  const unit = Number(price.dataset.unitPrice);
  const minimum = Number(quantity.min || 1);
  const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const update = () => { price.textContent = formatter.format((Number(quantity.value) || minimum) * unit / minimum); };
  quantity.addEventListener("input", update);
  update();
}

document.querySelectorAll(".artwork-input").forEach(input => {
  input.addEventListener("change", () => {
    const preview = input.closest("label")?.querySelector(".artwork-preview");
    if (preview) preview.textContent = input.files?.[0] ? `Selected: ${input.files[0].name}` : "";
  });
});

const postalInput = document.querySelector('input[name="postal_code"]');
const shippingBox = document.querySelector(".shipping-estimate");
if (postalInput && shippingBox) {
  const subtotal = Number(shippingBox.dataset.subtotal || 0);
  const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const updateShipping = () => {
    const pin = postalInput.value.trim();
    if (pin.length < 2) {
      shippingBox.textContent = "Enter PIN code for exact shipping.";
      return;
    }
    const fee = subtotal >= 999 ? 0 : /^(11|40|41|56|57|60|70)/.test(pin) ? 99 : 149;
    shippingBox.textContent = `Estimated shipping: ${fee === 0 ? "FREE" : formatter.format(fee)}`;
  };
  postalInput.addEventListener("input", updateShipping);
  updateShipping();
}

const checkoutForm = document.querySelector("#checkout-form");
checkoutForm?.addEventListener("submit", async event => {
  const selectedPayment = checkoutForm.querySelector('input[name="payment_method"]:checked')?.value;
  if (selectedPayment !== "razorpay") return;
  event.preventDefault();
  if (!checkoutForm.reportValidity()) return;

  const button = checkoutForm.querySelector('button[type="submit"]');
  const formData = new FormData(checkoutForm);
  button.disabled = true;
  button.textContent = "Opening secure payment…";

  try {
    const response = await fetch("/payment/create", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(formData)
    });
    const order = await response.json();
    if (!response.ok) throw new Error(order.error || "Could not start payment.");

    const razorpay = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: "PrintOasis",
      description: "Custom print order",
      order_id: order.orderId,
      prefill: {
        name: formData.get("customer_name"),
        contact: formData.get("phone")
      },
      theme: { color: "#1647d8" },
      handler(payment) {
        const verification = document.createElement("form");
        verification.method = "post";
        verification.action = "/payment/verify";
        const values = Object.fromEntries(formData);
        Object.assign(values, payment);
        for (const [name, value] of Object.entries(values)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          verification.appendChild(input);
        }
        document.body.appendChild(verification);
        verification.submit();
      },
      modal: {
        ondismiss() {
          button.disabled = false;
          button.textContent = button.dataset.originalText;
        }
      }
    });
    razorpay.on("payment.failed", response => {
      alert(response.error.description || "Payment failed. Please try again.");
      button.disabled = false;
      button.textContent = button.dataset.originalText;
    });
    razorpay.open();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = button.dataset.originalText;
  }
});

if (checkoutForm) {
  const button = checkoutForm.querySelector('button[type="submit"]');
  button.dataset.originalText = button.textContent;
}
