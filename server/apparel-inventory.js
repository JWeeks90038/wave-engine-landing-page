const { getApps, initializeApp, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { products } = require("./apparel-catalog");
const { getMode } = require("./apparel-stripe");

const sizes = ["S", "M", "L", "XL", "XXL"];

function firebaseApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_PROJECT_ID) throw new Error("FIREBASE_PROJECT_ID is not configured.");
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON && JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (serviceAccount && serviceAccount.project_id !== process.env.FIREBASE_PROJECT_ID) {
    throw new Error("Firebase service account project does not match FIREBASE_PROJECT_ID.");
  }
  return initializeApp({
    credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}
function database() { return getFirestore(firebaseApp()); }
function version(snapshot) {
  return snapshot.exists ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : null;
}
function quantity(snapshot) {
  const value = snapshot.exists && snapshot.data().quantity;
  if (snapshot.exists && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid inventory record: ${snapshot.ref.path}`);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function refs(db, productId) {
  const product = db.collection("products").doc(`${getMode()}_${productId}`);
  return { product, inventory: sizes.map((size) => product.collection("inventory").doc(size)) };
}
async function inventoryForProducts(db = database()) {
  return Promise.all(products.map(async (product) => {
    const ref = refs(db, product.id);
    const [doc, ...stock] = await db.getAll(ref.product, ...ref.inventory);
    return {
      id: product.id,
      active: doc.exists && doc.data().active === true,
      initialized: doc.exists,
      quantities: Object.fromEntries(sizes.map((size, index) => [size, quantity(stock[index])])),
      versions: Object.fromEntries(sizes.map((size, index) => [size, version(stock[index])])),
      updatedAt: stock.reduce((latest, entry) => {
        const time = entry.exists && entry.data().updatedAt;
        const value = time && typeof time.toMillis === "function" ? time.toMillis() : 0;
        return Math.max(latest, value);
      }, 0) || null
    };
  }));
}
async function checkAvailability(items, db = database()) {
  const inventory = await inventoryForProducts(db);
  for (const item of items) {
    const stock = inventory.find((entry) => entry.id === item.product.id);
    const requested = items.filter((entry) => entry.product.id === item.product.id && entry.size === item.size)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    if (!stock || !stock.active || stock.quantities[item.size] < requested) {
      const error = new Error("Sorry, this size is no longer available. Please update your cart.");
      error.statusCode = 409;
      throw error;
    }
  }
}
async function updateInventory(id, quantities, versions, uid, db = database()) {
  const product = products.find((entry) => entry.id === id);
  if (!product || !quantities || !versions || !uid ||
      Object.keys(quantities).length !== sizes.length ||
      sizes.some((size) => !Number.isSafeInteger(quantities[size]) || quantities[size] < 0 ||
        !(versions[size] === null || typeof versions[size] === "string"))) {
    const error = new Error("Enter a non-negative whole number for every size.");
    error.statusCode = 400;
    throw error;
  }
  const ref = refs(db, id);
  await db.runTransaction(async (tx) => {
    const [doc, ...stock] = await tx.getAll(ref.product, ...ref.inventory);
    if (stock.some((entry, index) => version(entry) !== versions[sizes[index]])) {
      const error = new Error("Inventory changed since you loaded it. Refresh and try again.");
      error.statusCode = 409;
      throw error;
    }
    if (!doc.exists) {
      tx.create(ref.product, { name: product.name, price: product.previewPrice, image: product.images[0].src, active: true });
    }
    sizes.forEach((size, index) => tx.set(ref.inventory[index], {
      size, quantity: quantities[size], updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    }));
  });
}
async function requireAdmin(request, authFactory = () => getAuth(firebaseApp())) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || "");
  if (!match) {
    const error = new Error("Sign in as an administrator.");
    error.statusCode = 401;
    throw error;
  }
  let token;
  try { token = await authFactory().verifyIdToken(match[1], true); }
  catch (cause) {
    if (!["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired",
      "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"].includes(cause.code)) throw cause;
    const error = new Error("Your session is invalid or expired. Sign in again.");
    error.statusCode = 401;
    throw error;
  }
  if (token.admin !== true) {
    const error = new Error("Administrator access is required.");
    error.statusCode = 403;
    throw error;
  }
  return token.uid;
}

function sessionItems(session) {
  const metadata = session.metadata || {};
  const keys = Object.keys(metadata).filter((key) => /^variants_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  if (!keys.length) throw new Error("Paid session is missing variants.");
  const seen = new Set();
  const items = keys.flatMap((key) => {
    const parsed = JSON.parse(metadata[key]);
    if (!Array.isArray(parsed)) throw new Error("Paid session has invalid variants.");
    return parsed.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 4) throw new Error("Paid session has invalid variants.");
      const [id, size, color, count] = entry;
      if (typeof id !== "string" || !/^[a-z0-9_-]+(?: [a-z0-9_-]+)*$/.test(id) || !sizes.includes(size) ||
          typeof color !== "string" || !Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error("Paid session has invalid variants.");
      }
      const key = JSON.stringify([id, size, color]);
      if (seen.has(key)) throw new Error("Paid session has duplicate variants.");
      seen.add(key);
      const product = products.find((entry) => entry.id === id);
      return { product: product || { id, name: id }, supported: Boolean(product && product.colors.includes(color)),
        size, color, quantity: count };
    });
  });
  if (!items.length || items.length > 100) throw new Error("Paid session has invalid variants.");
  return items;
}

async function confirmPaidOrder(session, lineItems, db = database()) {
  if (session.payment_status !== "paid" || session.metadata?.inventoryVersion !== "1") {
    throw new Error("Order payment is not confirmed.");
  }
  const items = sessionItems(session);
  if (lineItems.length !== items.length || lineItems.some((line, index) =>
    line.quantity !== items[index].quantity || !Number.isSafeInteger(line.amount_subtotal) ||
    line.amount_subtotal < 0 || line.amount_subtotal % line.quantity !== 0)) {
    throw new Error("Paid session line items do not match its variants.");
  }
  const shipping = session.collected_information?.shipping_details || session.shipping_details;
  const address = shipping?.address;
  if (!shipping?.name || !address?.line1 || !address.city || !address.state ||
      !address.postal_code || address.country !== "US" || !session.customer_details?.email) {
    throw new Error("Paid apparel session is missing customer or shipping details.");
  }
  const orderRef = db.collection("orders").doc(session.id);
  const grouped = [];
  for (const item of items) {
    const existing = grouped.find((entry) => entry.product.id === item.product.id && entry.size === item.size);
    if (existing) existing.quantity += item.quantity;
    else grouped.push({ product: item.product, size: item.size, quantity: item.quantity });
  }
  const itemRefs = grouped.map((item) => {
    const ref = refs(db, item.product.id);
    return { product: ref.product, inventory: ref.inventory[sizes.indexOf(item.size)] };
  });
  // The order marker and all deductions commit together; a retried webhook cannot deduct twice.
  return db.runTransaction(async (tx) => {
    const prior = await tx.get(orderRef);
    if (prior.exists) return prior.data();
    const docs = await tx.getAll(...itemRefs.flatMap((ref) => [ref.product, ref.inventory]));
    const available = items.every((item) => item.supported) && grouped.every((item, index) => docs[index * 2].exists &&
      docs[index * 2].data().active === true && quantity(docs[index * 2 + 1]) >= item.quantity);
    const order = {
      sessionId: session.id,
      mode: session.livemode ? "live" : "test",
      paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
      paymentStatus: available ? "paid" : "refund_pending",
      fulfillmentStatus: available ? "unfulfilled" : "not_fulfillable",
      customer: { name: shipping.name, email: session.customer_details.email, phone: session.customer_details.phone || null, shippingAddress: address },
      items: items.map((item, index) => ({
        productId: item.product.id, productName: item.product.name, size: item.size,
        color: item.color, quantity: item.quantity, price: lineItems[index].amount_subtotal / item.quantity
      })),
      inventoryDeductions: available ? grouped.map((item, index) => ({
        productId: item.product.id, size: item.size, quantity: item.quantity,
        before: quantity(docs[index * 2 + 1]), after: quantity(docs[index * 2 + 1]) - item.quantity
      })) : [],
      createdAt: FieldValue.serverTimestamp()
    };
    if (!order.paymentIntent) throw new Error("Paid session has no payment intent.");
    if (available) grouped.forEach((item, index) => tx.update(itemRefs[index].inventory, {
      quantity: quantity(docs[index * 2 + 1]) - item.quantity,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: `order:${session.id}`
    }));
    tx.create(orderRef, order);
    return order;
  });
}

async function processPaidSession(stripe, session, db = database()) {
  const lineItems = [];
  for await (const item of stripe.checkout.sessions.listLineItems(session.id, { limit: 100 })) lineItems.push(item);
  const order = await confirmPaidOrder(session, lineItems, db);
  if (order.paymentStatus === "refund_pending") {
    // Only verified Stripe payments reach this path; the stable key makes webhook retries safe.
    let refund = await stripe.refunds.create({ payment_intent: order.paymentIntent }, {
      idempotencyKey: `apparel-stock-refund-${session.id}`
    });
    if (refund.status === "pending") refund = await stripe.refunds.retrieve(refund.id);
    await db.collection("orders").doc(session.id).update({
      refundId: refund.id, refundStatus: refund.status,
      ...(refund.status === "succeeded" ? { paymentStatus: "refunded" } : {})
    });
    if (refund.status !== "succeeded") throw new Error(`Refund ${refund.id} is ${refund.status}; review in Stripe.`);
  }
}

module.exports = { firebaseApp, database, inventoryForProducts, checkAvailability, updateInventory, requireAdmin, confirmPaidOrder, processPaidSession };
