const nodemailer = require("nodemailer");

function escHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function createEmailService(config) {
  const configured = config.enabled !== false && Boolean(config.host && config.from);
  const transporter = configured ? nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  }) : null;

  return {
    configured,
    async send(message) {
      if (!transporter) return { delivered: false, skipped: true, reason: "SMTP is not configured." };
      try {
        const result = await transporter.sendMail({ from: config.from, ...message });
        console.info(`Email sent to ${message.to}: ${result.messageId}`);
        return { delivered: true, messageId: result.messageId };
      } catch (error) {
        console.error(`Email delivery failed for ${message.to}: ${error.message}`);
        return { delivered: false, error: error.message };
      }
    }
  };
}

function orderEmailTemplate({ event, order, items, note, baseUrl, money }) {
  const orderLink = baseUrl ? `${baseUrl}/account/orders/${order.id}` : "";
  const trackingLink = order.tracking_url || "";
  const reviewLinks = items.map(item => ({
    name: item.product_name,
    url: orderLink ? `${orderLink}#review-${item.product_id}` : orderLink
  }));
  const details = event === "shipping_update"
    ? [["Courier", order.courier_name], ["Tracking number", order.tracking_number], ["ETA", order.estimated_delivery], ["Track package", trackingLink]]
    : [["Order", order.order_number], ["Total", money(order.total)]];
  const introduction = event === "shipping_update"
    ? "Your order has shipped and is now on its way."
    : event === "delivered"
      ? "Your order has been delivered. We hope it looks exactly right."
      : event === "review_reminder"
        ? "Your order is complete. Your feedback helps other customers print with confidence."
        : `Your order status is now: ${order.status}.`;
  const subject = event === "shipping_update"
    ? `PrintOasis order ${order.order_number} is on the way`
    : event === "delivered"
      ? `PrintOasis order ${order.order_number} delivered`
      : event === "review_reminder"
        ? `How was your PrintOasis order ${order.order_number}?`
        : `PrintOasis order ${order.order_number}: ${order.status}`;
  const text = [
    `Hi ${order.customer_name},`, "", introduction, note ? `Note: ${note}` : "",
    ...details.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
    event === "delivered" ? `Order summary: ${items.map(item => `${item.product_name} x ${item.quantity}`).join(", ")}` : "",
    event === "review_reminder" ? `Review your products: ${reviewLinks.map(link => `${link.name}${link.url ? ` - ${link.url}` : ""}`).join(", ")}` : "",
    orderLink ? `Order details: ${orderLink}` : ""
  ].filter(Boolean).join("\n");
  const detailRows = details.filter(([, value]) => value).map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#667085">${escHtml(label)}</td><td style="padding:6px 0">${label === "Track package" ? `<a href="${escHtml(value)}">Track package</a>` : escHtml(value)}</td></tr>`).join("");
  const summary = event === "delivered" ? `<h3 style="margin:24px 0 8px">Order summary</h3><ul>${items.map(item => `<li>${escHtml(item.product_name)} x ${item.quantity}</li>`).join("")}</ul>` : "";
  const reviewList = event === "review_reminder" ? `<h3 style="margin:24px 0 8px">Review your products</h3><ul>${reviewLinks.map(link => `<li>${link.url ? `<a href="${escHtml(link.url)}">${escHtml(link.name)}</a>` : escHtml(link.name)}</li>`).join("")}</ul>` : "";
  const action = orderLink ? `<p style="margin:24px 0"><a href="${escHtml(orderLink)}" style="background:#1647d8;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">View order details</a></p>` : "";
  const html = `<div style="max-width:620px;margin:auto;padding:28px;font-family:Arial,sans-serif;color:#172033"><h1 style="margin:0 0 20px;color:#1647d8">PrintOasis</h1><p>Hi ${escHtml(order.customer_name)},</p><p>${escHtml(introduction)}</p>${note ? `<p><strong>Note:</strong> ${escHtml(note)}</p>` : ""}<table style="border-collapse:collapse">${detailRows}</table>${summary}${reviewList}${action}<p style="color:#667085;font-size:13px">PrintOasis Print Services</p></div>`;
  return { subject, text, html };
}

module.exports = { createEmailService, orderEmailTemplate };
