const sizes = ["S", "M", "L", "XL", "XXL", "XXXL"];

const products = [
  {
    id: "original",
    name: "LISTEN UP AMERICA! - Original Edition",
    description: "Our flagship tee. A small left-chest wordmark meets a bold eagle-inspired back design.",
    stripePriceId: "price_1UZMA9I1ucU6ficLXaq2QZkD",
    previewPrice: 2499,
    currency: "usd",
    colors: ["Black", "White"],
    sizes,
    images: [
      { src: "Images/apparel/Logo Shirt Front 1.png", label: "Front" },
      { src: "Images/apparel/Logo Shirt Back 1.png", label: "Back" },
      { src: "Images/apparel/Prod Img Front 1.png", label: "On model, front" },
      { src: "Images/apparel/Prod Img Back 1.png", label: "On model, back" }
    ]
  },
  {
    id: "freedom",
    name: "LISTEN UP AMERICA! - Freedom Edition",
    description: "A distinct take on the American spirit, made for everyday expression.",
    stripePriceId: "price_1UZGZ3I1ucU6ficLtysDHW1K",
    previewPrice: 2999,
    currency: "usd",
    colors: ["Black", "White"],
    sizes,
    images: [
      { src: "Images/apparel/Logo Shirt Front 2.png", label: "Front" },
      { src: "Images/apparel/Logo Shirt Back 2.png", label: "Back" },
      { src: "Images/apparel/Prod Img Front 2.png", label: "On model, front" },
      { src: "Images/apparel/Prod Img Back 2.png", label: "On model, back" }
    ]
  }
];

function validateCart(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new Error("The cart must contain between 1 and 100 items.");
  }
  const seen = new Set();
  return items.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid cart item.");
    const product = products.find((entry) => entry.id === item.id);
    if (!product || !product.sizes.includes(item.size) || !product.colors.includes(item.color) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new Error("Invalid product, size, color, or quantity.");
    }
    const key = JSON.stringify([item.id, item.size, item.color]);
    if (seen.has(key)) throw new Error("Duplicate cart variants are not allowed.");
    seen.add(key);
    return { product, size: item.size, color: item.color, quantity: item.quantity };
  });
}

module.exports = { products, validateCart };
