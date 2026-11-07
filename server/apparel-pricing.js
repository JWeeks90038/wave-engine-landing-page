function validateStripePrice(price, product) {
  if (!price || price.id !== product.stripePriceId || price.livemode !== true ||
      !price.active || price.type !== "one_time" || price.currency !== product.currency ||
      !Number.isSafeInteger(price.unit_amount) || price.unit_amount < 0 ||
      price.billing_scheme !== "per_unit" || price.custom_unit_amount || price.transform_quantity ||
      price.tax_behavior === "inclusive") {
    throw new Error(`Stripe price is unavailable or unsupported for ${product.id}.`);
  }
  return price.unit_amount;
}

async function getPublicProducts(products, getStripe) {
  return Promise.all(products.map(async (product) => {
    const { stripePriceId, previewPrice, ...publicProduct } = product;
    if (!stripePriceId) return publicProduct;
    try {
      const price = await getStripe().prices.retrieve(stripePriceId);
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

module.exports = { validateStripePrice, getPublicProducts, cartMetadata };
