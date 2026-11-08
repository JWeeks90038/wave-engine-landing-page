const { getMode, getPriceId } = require("./apparel-stripe");

function validateStripePrice(price, product) {
  if (!price || price.id !== getPriceId(product) || price.livemode !== (getMode() === "live") ||
      !price.active || price.type !== "one_time" || price.currency !== product.currency ||
      price.unit_amount !== product.previewPrice ||
      price.billing_scheme !== "per_unit" || price.custom_unit_amount || price.transform_quantity ||
      price.tax_behavior === "inclusive") {
    throw new Error(`Stripe price is unavailable or unsupported for ${product.id}.`);
  }
  return price.unit_amount;
}

async function getPublicProducts(products, getStripe) {
  return Promise.all(products.map(async (product) => {
    const { stripePriceId, previewPrice, ...publicProduct } = product;
    try {
      const price = await getStripe().prices.retrieve(getPriceId(product));
      return { ...publicProduct, price: validateStripePrice(price, product) };
    } catch (error) {
      console.error(`Apparel price unavailable for ${product.id}:`, error.message);
      return { ...publicProduct, price: null, previewPrice };
    }
  }));
}

function cartMetadata(items) {
  const metadata = { storefront: "wave-apparel-v1" };
  let batch = [];
  for (const { product, size, color, quantity } of items) {
    const item = [product.id, size, color, quantity];
    if (JSON.stringify([...batch, item]).length > 500) {
      metadata[`variants_${Object.keys(metadata).length}`] = JSON.stringify(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) metadata[`variants_${Object.keys(metadata).length}`] = JSON.stringify(batch);
  if (Object.keys(metadata).length > 50) throw new Error("Too many cart variants for checkout.");
  return metadata;
}

function shippingForSubtotal(subtotal) {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw new Error("Invalid merchandise subtotal.");
  return subtotal >= 7500 ? 0 : 599;
}

module.exports = { validateStripePrice, getPublicProducts, cartMetadata, shippingForSubtotal };
