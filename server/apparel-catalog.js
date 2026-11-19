const sizes = ["S", "M", "L", "XL", "XXL"];

const products = [
  {
    id: "freedom 1",
    name: "FREEDOM UNFILTERED - Jones Edition",
    description: "Our flagship tee. A small left-chest wordmark meets a bold eagle-inspired back design.",
    stripePriceId: "price_1UdJoFI1ucU6ficLNv2OpOsZ",
    previewPrice: 2999,
    currency: "usd",
    colors: ["Black"],
    sizes,
    images: [
      { src: "Images/apparel/Freedom Unfiltered T-shirt in patriotic studio light.png", label: "Front" },
      { src: "Images/apparel/Freedom Unfiltered shirt on dark patriotic backdrop.png", label: "Back" },
      { src: "Images/apparel/Freedom Unfiltered T-Shirt Studio Portrait (1).png", label: "On model, front" },
      { src: "Images/apparel/Freedom Unfiltered Black T-Shirt Portrait.png", label: "On model, back" },
      { src: "Images/apparel/Freedom eagle shirt back print.png", label: "Alternate front" },
      { src: "Images/apparel/Freedom Unfiltered Eagle T-Shirt Showcase.png", label: "Alternate back" },
      { src: "Images/apparel/Freedom Unfiltered four-model apparel showcase.png", label: "Alternate back" }
    ]
  },
  {
    id: "freedom 2",
    name: "FREEDOM UNFILTERED - Henry Edition",
    description: "A distinct take on the American spirit, made for everyday expression.",
    stripePriceId: "price_1UdJpQI1ucU6ficLQKwj9UYD",
    previewPrice: 2999,
    currency: "usd",
    colors: ["Black"],
    sizes,
    images: [
      { src: "Images/apparel/Freedom Unfiltered T-shirt in patriotic studio light.png", label: "Front" },
      { src: "Images/apparel/Black Freedom Unfiltered shirt, patriotic studio backdrop.png", label: "Back" },
      { src: "Images/apparel/Freedom Unfiltered T-Shirt Studio Portrait (1).png", label: "On model, front" },
      { src: "Images/apparel/Freedom Unfiltered Black T-Shirt Portrait.png", label: "On model, back" },
      { src: "Images/apparel/Freedom Eagle Graphic T-Shirt.png", label: "Alternate front" },
      { src: "Images/apparel/Freedom_Unfiltered_Woman_Back_Product_1312x1199_Close_Crop.png", label: "Alternate back" },
      { src: "Images/apparel/Freedom Unfiltered four-model apparel showcase.png", label: "Alternate back" }
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
