const menuButton = document.querySelector(".menu-toggle");
const categoryNav = document.querySelector(".category-nav");
const megaWraps = [...document.querySelectorAll(".mega-nav-wrap")];
const desktopNavigation = window.matchMedia("(min-width: 681px)");
let megaMenuCloseTimer = 0;
let desktopMegaPanel = null;
let desktopMegaShell = null;
const megaContents = new Map();

const setMobileNavigation = open => {
  categoryNav?.classList.toggle("open", open);
  menuButton?.setAttribute("aria-expanded", String(open));
};

const megaContentFor = wrap => megaContents.get(wrap) || wrap.querySelector(".mega-products-menu");

const setMegaMenu = (wrap, open) => {
  const toggle = wrap.querySelector(".mega-nav-toggle");
  const menu = megaContentFor(wrap);
  wrap.classList.toggle("is-open", open);
  toggle?.setAttribute("aria-expanded", String(open));
  menu?.toggleAttribute("hidden", !open && Boolean(desktopMegaPanel));
  menu?.setAttribute("aria-hidden", String(!open));
  if (!desktopMegaPanel) return;
  if (open) {
    megaWraps.forEach(item => {
      if (item === wrap) return;
      item.classList.remove("is-open");
      const content = megaContentFor(item);
      content?.setAttribute("aria-hidden", "true");
      content?.setAttribute("hidden", "");
    });
    desktopMegaPanel.classList.add("is-open");
    desktopMegaPanel.setAttribute("aria-hidden", "false");
  } else if (!megaWraps.some(item => item.classList.contains("is-open"))) {
    desktopMegaPanel.classList.remove("is-open");
    desktopMegaPanel.setAttribute("aria-hidden", "true");
  }
};

const closeMegaMenus = except => megaWraps.forEach(wrap => {
  if (wrap !== except) setMegaMenu(wrap, false);
});

const cancelMegaMenuClose = () => {
  window.clearTimeout(megaMenuCloseTimer);
  megaMenuCloseTimer = 0;
};

const scheduleMegaMenuClose = () => {
  cancelMegaMenuClose();
  megaMenuCloseTimer = window.setTimeout(() => closeMegaMenus(), 180);
};

const openMegaMenu = wrap => {
  cancelMegaMenuClose();
  closeMegaMenus(wrap);
  setMegaMenu(wrap, true);
};

const createDesktopMegaPanel = () => {
  if (!categoryNav || desktopMegaPanel || !desktopNavigation.matches) return;
  desktopMegaShell = document.createElement("div");
  desktopMegaShell.className = "category-nav-shell";
  categoryNav.parentNode?.insertBefore(desktopMegaShell, categoryNav);
  desktopMegaShell.appendChild(categoryNav);
  desktopMegaPanel = document.createElement("div");
  desktopMegaPanel.className = "mega-products-menu mega-products-menu-shared";
  desktopMegaPanel.id = "desktop-mega-menu";
  desktopMegaPanel.setAttribute("aria-hidden", "true");
  desktopMegaShell.appendChild(desktopMegaPanel);
  megaWraps.forEach(wrap => {
    const menu = wrap.querySelector(".mega-products-menu");
    if (!menu) return;
    megaContents.set(wrap, menu);
    menu.classList.remove("mega-products-menu");
    menu.classList.add("mega-menu-content");
    menu.setAttribute("hidden", "");
    menu.setAttribute("aria-hidden", "true");
    desktopMegaPanel.appendChild(menu);
  });
};

const removeDesktopMegaPanel = () => {
  if (!desktopMegaPanel || !desktopMegaShell) return;
  cancelMegaMenuClose();
  megaWraps.forEach(wrap => {
    const menu = megaContents.get(wrap);
    if (!menu) return;
    menu.classList.remove("mega-menu-content");
    menu.classList.add("mega-products-menu");
    menu.removeAttribute("hidden");
    menu.setAttribute("aria-hidden", "true");
    wrap.appendChild(menu);
    wrap.classList.remove("is-open");
  });
  megaContents.clear();
  desktopMegaPanel.remove();
  desktopMegaShell.replaceWith(categoryNav);
  desktopMegaPanel = null;
  desktopMegaShell = null;
};

createDesktopMegaPanel();

menuButton?.addEventListener("click", () => setMobileNavigation(!categoryNav?.classList.contains("open")));
megaWraps.forEach(wrap => {
  const trigger = wrap.querySelector(".mega-nav-trigger");
  const toggle = wrap.querySelector(".mega-nav-toggle");
  const menu = wrap.querySelector(".mega-products-menu");
  toggle?.addEventListener("click", () => {
    cancelMegaMenuClose();
    const opening = !wrap.classList.contains("is-open");
    closeMegaMenus(wrap);
    setMegaMenu(wrap, opening);
  });
  wrap.addEventListener("mouseenter", () => {
    if (!desktopNavigation.matches) return;
    openMegaMenu(wrap);
  });
  trigger?.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    closeMegaMenus(wrap);
    setMegaMenu(wrap, true);
    menu?.querySelector("a")?.focus();
  });
});
categoryNav?.addEventListener("mouseenter", cancelMegaMenuClose);
categoryNav?.addEventListener("mouseleave", () => {
  if (desktopNavigation.matches) scheduleMegaMenuClose();
});
desktopMegaPanel?.addEventListener("mouseenter", cancelMegaMenuClose);
desktopMegaPanel?.addEventListener("mouseleave", () => {
  if (desktopNavigation.matches) scheduleMegaMenuClose();
});
document.addEventListener("click", event => {
  if (!megaWraps.some(wrap => wrap.contains(event.target)) && !desktopMegaPanel?.contains(event.target)) {
    cancelMegaMenuClose();
    closeMegaMenus();
  }
  if (categoryNav && !categoryNav.contains(event.target) && !menuButton?.contains(event.target)) setMobileNavigation(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    const openWrap = megaWraps.find(wrap => wrap.classList.contains("is-open"));
    cancelMegaMenuClose();
    closeMegaMenus();
    setMobileNavigation(false);
    (desktopNavigation.matches ? openWrap?.querySelector(".mega-nav-trigger") : openWrap?.querySelector(".mega-nav-toggle"))?.focus();
  }
});
desktopNavigation.addEventListener("change", event => {
  cancelMegaMenuClose();
  closeMegaMenus();
  if (event.matches) {
    createDesktopMegaPanel();
    desktopMegaPanel?.addEventListener("mouseenter", cancelMegaMenuClose);
    desktopMegaPanel?.addEventListener("mouseleave", () => scheduleMegaMenuClose());
    setMobileNavigation(false);
  } else removeDesktopMegaPanel();
});

const currentCategory = new URLSearchParams(window.location.search).get("category");
if (currentCategory) document.querySelector(`.mega-nav-trigger[data-category="${CSS.escape(currentCategory)}"]`)?.classList.add("is-active");

const savedTheme = localStorage.getItem("printoasis-theme");
if (savedTheme === "dark") document.documentElement.classList.add("dark-mode");
const themeToggle = document.querySelector(".theme-toggle");
themeToggle?.setAttribute("aria-pressed", String(document.documentElement.classList.contains("dark-mode")));
themeToggle?.addEventListener("click", () => {
  document.documentElement.classList.toggle("dark-mode");
  const darkMode = document.documentElement.classList.contains("dark-mode");
  localStorage.setItem("printoasis-theme", darkMode ? "dark" : "light");
  themeToggle.setAttribute("aria-pressed", String(darkMode));
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const feedbackStack = document.createElement("div");
feedbackStack.className = "feedback-stack";
feedbackStack.setAttribute("aria-live", "polite");
feedbackStack.setAttribute("aria-atomic", "true");
document.body.appendChild(feedbackStack);

const dismissFeedback = message => {
  window.clearTimeout(Number(message.dataset.dismissTimer));
  message.remove();
};

const showFeedback = (message, type = "success") => {
  const feedback = document.createElement("div");
  feedback.className = `feedback-message ${type}`;
  feedback.setAttribute("role", type === "error" ? "alert" : "status");
  feedback.innerHTML = `<span></span><button type="button" aria-label="Dismiss message">&times;</button>`;
  feedback.querySelector("span").textContent = message;
  feedback.querySelector("button").addEventListener("click", () => dismissFeedback(feedback));
  feedbackStack.appendChild(feedback);
  feedback.dataset.dismissTimer = String(window.setTimeout(() => dismissFeedback(feedback), 6000));
};

document.querySelectorAll("[data-copy-value]").forEach(button => {
  button.addEventListener("click", async () => {
    const value = button.dataset.copyValue || "";
    const label = button.dataset.copyLabel || "Value";
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement("textarea");
        input.value = value;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      showFeedback(`${label} copied.`);
    } catch {
      showFeedback(`Could not copy the ${label.toLowerCase()}.`, "error");
    }
  });
});

document.querySelectorAll(".product-photo img").forEach(image => {
  const frame = image.closest(".product-photo");
  if (!frame) return;
  const finish = () => frame.classList.remove("is-loading");
  image.addEventListener("load", finish);
  image.addEventListener("error", finish);
  if (image.complete) finish();
  else frame.classList.add("is-loading");
});

document.querySelectorAll("[data-product-gallery]").forEach(gallery => {
  const mainImage = gallery.querySelector(".product-gallery-main img");
  if (!mainImage) return;
  gallery.querySelectorAll("[data-gallery-image]").forEach(button => {
    button.addEventListener("click", () => {
      const source = button.dataset.imageSrc;
      if (!source || source === mainImage.getAttribute("src")) return;
      const frame = mainImage.closest(".product-photo");
      frame?.classList.add("is-loading");
      mainImage.src = source;
      mainImage.alt = button.dataset.imageAlt || mainImage.alt;
      gallery.querySelectorAll("[data-gallery-image]").forEach(item => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-current", String(active));
      });
    });
  });
});

const backToTop = document.createElement("button");
backToTop.className = "back-to-top";
backToTop.type = "button";
backToTop.setAttribute("aria-label", "Back to top");
backToTop.textContent = "↑";
document.body.appendChild(backToTop);
const toggleBackToTop = () => backToTop.classList.toggle("is-visible", window.scrollY > 560);
window.addEventListener("scroll", toggleBackToTop, { passive: true });
backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" }));
toggleBackToTop();

document.querySelectorAll(".notice").forEach(notice => {
  const dismiss = () => notice.remove();
  notice.querySelector(".notice-dismiss")?.addEventListener("click", dismiss);
  window.setTimeout(dismiss, 7000);
});

document.querySelectorAll("[data-carousel]").forEach(carousel => {
  const track = carousel.querySelector(":scope > .carousel-track, :scope .offers-viewport > .carousel-track, :scope .testimonials-viewport > .carousel-track");
  const slides = track ? [...track.children] : [];
  const dots = [...carousel.querySelectorAll("[data-carousel-dot]")];
  const previous = carousel.querySelector(".carousel-arrow.previous");
  const next = carousel.querySelector(".carousel-arrow.next");
  const interval = Number(carousel.dataset.carouselInterval || 7000);
  let active = 0;
  let timer;
  let startX = 0;

  if (!track || slides.length < 2) return;

  const show = index => {
    active = (index + slides.length) % slides.length;
    track.style.transform = `translateX(-${active * 100}%)`;
    slides.forEach((slide, slideIndex) => {
      const selected = slideIndex === active;
      slide.classList.toggle("is-active", selected);
      slide.setAttribute("aria-hidden", String(!selected));
    });
    dots.forEach((dot, dotIndex) => dot.setAttribute("aria-selected", String(dotIndex === active)));
  };
  const stop = () => window.clearInterval(timer);
  const start = () => {
    stop();
    if (!reducedMotion) timer = window.setInterval(() => show(active + 1), interval);
  };
  previous?.addEventListener("click", () => { show(active - 1); start(); });
  next?.addEventListener("click", () => { show(active + 1); start(); });
  dots.forEach((dot, index) => dot.addEventListener("click", () => { show(index); start(); }));
  carousel.addEventListener("mouseenter", stop);
  carousel.addEventListener("mouseleave", start);
  carousel.addEventListener("focusin", stop);
  carousel.addEventListener("focusout", event => {
    if (!carousel.contains(event.relatedTarget)) start();
  });
  carousel.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") { event.preventDefault(); show(active - 1); start(); }
    if (event.key === "ArrowRight") { event.preventDefault(); show(active + 1); start(); }
  });
  track.addEventListener("pointerdown", event => { startX = event.clientX; });
  track.addEventListener("pointerup", event => {
    if (Math.abs(event.clientX - startX) < 40) return;
    show(active + (event.clientX < startX ? 1 : -1));
    start();
  });
  show(0);
  start();
});

document.querySelectorAll("[data-product-carousel]").forEach(carousel => {
  const viewport = carousel.querySelector(".product-carousel-viewport");
  const track = carousel.querySelector(".product-carousel-track");
  const previous = carousel.querySelector(".carousel-arrow.previous");
  const next = carousel.querySelector(".carousel-arrow.next");
  const interval = Number(carousel.dataset.carouselInterval || 8000);
  let timer;
  if (!viewport || !track || track.children.length < 2) return;

  const step = direction => {
    const card = track.firstElementChild;
    const amount = card ? card.getBoundingClientRect().width + 18 : viewport.clientWidth;
    const atEnd = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 4;
    if (direction > 0 && atEnd) viewport.scrollTo({ left: 0, behavior: reducedMotion ? "auto" : "smooth" });
    else viewport.scrollBy({ left: amount * direction, behavior: reducedMotion ? "auto" : "smooth" });
  };
  const stop = () => window.clearInterval(timer);
  const start = () => {
    stop();
    if (!reducedMotion) timer = window.setInterval(() => step(1), interval);
  };
  previous?.addEventListener("click", () => { step(-1); start(); });
  next?.addEventListener("click", () => { step(1); start(); });
  carousel.addEventListener("mouseenter", stop);
  carousel.addEventListener("mouseleave", start);
  carousel.addEventListener("focusin", stop);
  carousel.addEventListener("focusout", event => { if (!carousel.contains(event.relatedTarget)) start(); });
  start();
});

const revealItems = document.querySelectorAll(".reveal-on-scroll, .home-statistics");
const countUp = element => {
  const target = Number(element.dataset.count || 0);
  const started = performance.now();
  const duration = Math.min(1400, Math.max(500, target * 10));
  const render = now => {
    const progress = Math.min(1, (now - started) / duration);
    element.textContent = Math.round(target * (1 - (1 - progress) ** 3)).toLocaleString("en-IN");
    if (progress < 1) requestAnimationFrame(render);
  };
  if (reducedMotion) element.textContent = target.toLocaleString("en-IN");
  else requestAnimationFrame(render);
};

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-visible");
    entry.target.querySelectorAll("[data-count]").forEach(countUp);
    observer.unobserve(entry.target);
  }), { threshold: 0.2 });
  revealItems.forEach(item => observer.observe(item));
} else {
  revealItems.forEach(item => {
    item.classList.add("is-visible");
    item.querySelectorAll("[data-count]").forEach(countUp);
  });
}

const searchInput = document.querySelector('.search input[name="q"]');
const searchForm = document.querySelector("[data-search-form]");
if (searchInput && searchForm) {
  const suggestionPanel = searchForm.querySelector("#search-suggestions");
  const recentSection = searchForm.querySelector("[data-search-recent]");
  const recentList = recentSection?.querySelector("div");
  const liveSection = searchForm.querySelector("[data-search-results]");
  const liveList = liveSection?.querySelector("div");
  const storageKey = "printoasis-recent-searches";
  let requestId = 0;
  let searchTimer;

  const recentSearches = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved.filter(item => typeof item === "string").slice(0, 4) : [];
    } catch {
      return [];
    }
  };
  const productLink = term => {
    const link = document.createElement("a");
    link.href = `/products?q=${encodeURIComponent(term)}`;
    link.textContent = term;
    return link;
  };
  const renderRecent = () => {
    const items = recentSearches();
    if (!recentSection || !recentList) return;
    recentSection.hidden = !items.length;
    recentList.replaceChildren(...items.map(productLink));
  };
  const setSuggestionsOpen = open => {
    if (!suggestionPanel) return;
    suggestionPanel.hidden = !open;
    searchInput.setAttribute("aria-expanded", String(open));
    if (open) renderRecent();
  };
  const saveRecentSearch = term => {
    if (!term) return;
    const items = [term, ...recentSearches().filter(item => item.toLowerCase() !== term.toLowerCase())].slice(0, 4);
    localStorage.setItem(storageKey, JSON.stringify(items));
  };

  searchInput.addEventListener("focus", () => setSuggestionsOpen(true));
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    window.clearTimeout(searchTimer);
    setSuggestionsOpen(true);
    if (query.length < 2) {
      if (liveSection) liveSection.hidden = true;
      return;
    }
    searchTimer = window.setTimeout(async () => {
      const currentRequest = ++requestId;
      try {
        const response = await fetch(`/api/search-suggestions?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error("Search suggestions are unavailable.");
        const data = await response.json();
        if (currentRequest !== requestId || !liveList || !liveSection) return;
        liveList.replaceChildren(...data.suggestions.map(productLink));
        liveSection.hidden = !data.suggestions.length;
      } catch {
        if (liveSection) liveSection.hidden = true;
      }
    }, 160);
  });
  searchForm.addEventListener("submit", () => saveRecentSearch(searchInput.value.trim()));
  document.addEventListener("click", event => {
    if (!searchForm.contains(event.target)) setSuggestionsOpen(false);
  });
  searchInput.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      setSuggestionsOpen(false);
      searchInput.blur();
    }
  });
}

const quantity = document.querySelector('input[name="quantity"]');
const price = document.querySelector("[data-unit-price]");
if (quantity && price) {
  const unit = Number(price.dataset.unitPrice);
  const minimum = Number(quantity.min || 1);
  const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const update = () => { price.textContent = formatter.format((Number(quantity.value) || minimum) * unit); };
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
  const releasePaymentReservation = () => fetch("/payment/failed", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(formData)
  }).catch(() => {});
  const resetPaymentButton = () => {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    button.textContent = button.dataset.originalText;
  };
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
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
          resetPaymentButton();
        }
      }
    });
    razorpay.on("payment.failed", response => {
      releasePaymentReservation();
      showFeedback(response.error.description || "Payment failed. Your reserved cart items were released.", "error");
      resetPaymentButton();
    });
    razorpay.open();
  } catch (error) {
    showFeedback(error.message || "Could not start payment. Please try again.", "error");
    resetPaymentButton();
  }
});

if (checkoutForm) {
  const button = checkoutForm.querySelector('button[type="submit"]');
  button.dataset.originalText = button.textContent;
}

const loadingLabels = {
  "/login": "Signing you in...",
  "/register": "Creating your account...",
  "/logout": "Signing out...",
  "/cart/add": "Adding to cart...",
  "/cart/update": "Updating your cart...",
  "/cart/remove": "Removing item...",
  "/wishlist/toggle": "Updating wishlist...",
  "/checkout": "Placing your order...",
  "/profile": "Saving your profile...",
  "/profile/password": "Updating password...",
  "/review": "Saving your review...",
  "/admin/products": "Saving product...",
  "/admin/coupons": "Saving coupon...",
  "/admin/orders": "Updating order..."
};

const resetLoadingForm = form => {
  const button = form.querySelector("button.is-loading");
  if (!button) return;
  button.disabled = false;
  button.classList.remove("is-loading");
  button.removeAttribute("aria-busy");
  button.textContent = button.dataset.originalText || button.textContent;
  form.dataset.submitting = "false";
};

document.querySelectorAll("form").forEach(form => {
  form.addEventListener("submit", event => {
    if (event.defaultPrevented || form.dataset.submitting === "true" || !form.checkValidity()) return;
    const button = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;

    form.dataset.submitting = "true";
    button.dataset.originalText ||= button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");

    const action = new URL(form.getAttribute("action") || window.location.pathname, window.location.origin).pathname;
    let note = form.querySelector(".form-loading-note");
    if (!note) {
      note = document.createElement("p");
      note.className = "form-loading-note";
      note.setAttribute("aria-live", "polite");
      form.appendChild(note);
    }
    note.textContent = loadingLabels[action] || "Saving your changes...";
  });
});

window.addEventListener("pageshow", () => document.querySelectorAll("form").forEach(resetLoadingForm));
