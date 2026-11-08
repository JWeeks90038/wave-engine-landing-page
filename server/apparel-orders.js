const { getStripe, getMode } = require("./apparel-stripe");

function orderFromSession(session, lineItems) {
  const shipping = session.collected_information?.shipping_details || session.shipping_details;
  const address = shipping?.address;
  if (!shipping?.name || !address?.line1 || !address.city || !address.state ||
      !address.postal_code || address.country !== "US" || !session.customer_details?.email) {
    throw new Error(`Session ${session.id} is missing customer or shipping details; review it in Stripe.`);
  }
  const keys = Object.keys(session.metadata || {}).filter((key) => /^variants_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  if (!keys.length) throw new Error(`Session ${session.id} is missing variant metadata; review it in Stripe.`);
  const variants = keys.flatMap((key) => {
    const batch = JSON.parse(session.metadata[key]);
    if (!Array.isArray(batch)) throw new Error(`Session ${session.id} has invalid variants.`);
    return batch;
  });
  if (variants.length !== lineItems.length) throw new Error(`Session ${session.id} has mismatched line items and variants.`);
  const items = variants.map((variant) => {
    if (!Array.isArray(variant) || variant.length !== 4 ||
        typeof variant[0] !== "string" || typeof variant[1] !== "string" || typeof variant[2] !== "string" ||
        !Number.isInteger(variant[3]) || variant[3] < 1) {
      throw new Error(`Session ${session.id} has invalid order variants.`);
    }
    return { design: variant[0], size: variant[1], color: variant[2], quantity: variant[3] };
  });
  if (items.reduce((sum, item) => sum + item.quantity, 0) !== lineItems.reduce((sum, item) => sum + item.quantity, 0)) {
    throw new Error(`Session ${session.id} has mismatched quantities.`);
  }
  return {
    mode: session.livemode ? "live" : "test",
    sessionId: session.id,
    paymentReference: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    date: new Date(session.created * 1000).toISOString(),
    paymentStatus: session.payment_status,
    customer: { name: shipping.name, email: session.customer_details.email, phone: session.customer_details.phone || null, shippingAddress: address },
    items,
    stripeLineItems: lineItems.map((item) => ({ description: item.description, quantity: item.quantity, amountTotal: item.amount_total })),
    currency: session.currency,
    merchandiseSubtotal: session.amount_subtotal,
    shippingCharge: session.shipping_cost?.amount_total ?? session.total_details?.amount_shipping,
    salesTax: session.total_details?.amount_tax,
    totalPaid: session.amount_total
  };
}

async function listPaidOrders(stripe) {
  const orders = [];
  const review = [];
  for await (const session of stripe.checkout.sessions.list({ status: "complete", limit: 100 })) {
    if (session.livemode !== (getMode() === "live") || session.metadata?.storefront !== "wave-apparel-v1" || session.payment_status !== "paid") continue;
    try {
      const items = [];
      for await (const item of stripe.checkout.sessions.listLineItems(session.id, { limit: 100 })) items.push(item);
      orders.push(orderFromSession(session, items));
    } catch (error) {
      review.push({ sessionId: session.id, error: error.message });
    }
  }
  return { mode: getMode(), orders, review };
}

if (require.main === module) {
  Promise.resolve().then(() => listPaidOrders(getStripe())).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.review.length) process.exitCode = 1;
  }).catch((error) => {
    console.error("Could not retrieve apparel orders:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { orderFromSession, listPaidOrders };
