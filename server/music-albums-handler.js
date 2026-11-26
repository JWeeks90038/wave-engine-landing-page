const crypto = require("crypto");
const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const music = require("./music-library");
const payments = require("./music-payments");

const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const validPrice = (price) => Number.isSafeInteger(price) && price >= 50 && price <= 10000;
const validArchive = (id, path) => typeof path === "string" &&
  new RegExp(`^musicAlbums/${id}/[a-zA-Z0-9_-]{1,128}/album\\.zip$`).test(path);

function availableAlbum(id, album) {
  return validId(id) && album && album.published === true &&
    typeof album.title === "string" && album.title.trim().length > 0 && album.title.length <= 160 &&
    validPrice(album.priceCents) && validArchive(id, album.archivePath) &&
    Array.isArray(album.songTitles) && album.songTitles.length >= 1 && album.songTitles.length <= 20 &&
    album.songTitles.every((title) => typeof title === "string" && title.trim().length > 0 && title.length <= 160);
}

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createHandler({ database = music.database, bucket = music.bucket, payment = payments } = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    response.setHeader("Cache-Control", "private, no-store");
    const params = new URL(request.url, "http://localhost").searchParams;
    const action = params.get("action");
    try {
      const db = database();
      if (action === "albums" && request.method === "GET") {
        const snapshot = await db.collection("musicAlbums").where("published", "==", true).get();
        const albums = snapshot.docs.filter((doc) => availableAlbum(doc.id, doc.data())).map((doc) => {
          const album = doc.data();
          return { id: doc.id, title: album.title, priceCents: album.priceCents, songTitles: album.songTitles };
        }).sort((a, b) => a.title.localeCompare(b.title));
        return sendJson(response, 200, { albums });
      }
      if (action === "album-checkout" && request.method === "POST") {
        if (process.env.MUSIC_ALBUM_SALES_ENABLED !== "true" ||
            (payment.mode() === "live" && process.env.MUSIC_LIVE_CHECKOUT_ENABLED !== "true")) {
          throw fail("Album checkout is not available yet.", 503);
        }
        const { id } = await readJsonBody(request);
        if (!validId(id)) throw fail("Invalid album.", 400);
        const snapshot = await db.collection("musicAlbums").doc(id).get();
        const album = snapshot.exists && snapshot.data();
        if (!availableAlbum(id, album)) throw fail("This album is not available for purchase.", 404);
        const [metadata] = await bucket().file(album.archivePath).getMetadata();
        const generation = String(metadata.generation || "");
        const size = Number(metadata.size);
        if (!/^\d+$/.test(generation) || !Number.isSafeInteger(size) || size <= 0 || size > 4 * 1024 ** 3) {
          throw new Error("Invalid album archive metadata.");
        }
        const purchaseId = crypto.randomBytes(24).toString("hex");
        const purchaseRef = db.collection("musicAlbumPurchases").doc(purchaseId);
        await purchaseRef.create({
          albumId: id, title: album.title, amount: album.priceCents, archivePath: album.archivePath,
          generation, mode: payment.mode(), createdAt: new Date()
        });
        const site = payment.siteUrl();
        const successUrl = new URL(`music-purchase?album_purchase=${purchaseId}&session_id={CHECKOUT_SESSION_ID}`, site).href
          .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
        const session = await payment.stripeClient().checkout.sessions.create({
          mode: "payment", payment_method_types: ["card"],
          line_items: [{ price_data: { currency: "usd", unit_amount: album.priceCents,
            product_data: { name: album.title } }, quantity: 1 }],
          metadata: { type: "music-album-v1", purchaseId },
          custom_text: { submit: { message: "Download link expires 10 minutes after payment. Personal listening only." } },
          success_url: successUrl, cancel_url: new URL("music", site).href
        });
        if (!session.url || session.livemode !== (payment.mode() === "live") ||
            !new RegExp(`^cs_${payment.mode()}_[A-Za-z0-9]+$`).test(session.id || "")) {
          throw new Error("Stripe returned an invalid checkout session.");
        }
        await purchaseRef.update({ sessionId: session.id });
        return sendJson(response, 200, { url: session.url });
      }
      if ((action === "album-purchase" || action === "album-download") && request.method === "GET") {
        const purchaseId = params.get("purchase_id");
        const sessionId = params.get("session_id");
        const mode = payment.mode();
        if (!/^[a-f0-9]{48}$/.test(purchaseId || "") ||
            !new RegExp(`^cs_${mode}_[A-Za-z0-9]+$`).test(sessionId || "")) throw payment.denied();
        const record = await db.collection("musicAlbumPurchases").doc(purchaseId).get();
        const purchase = record.exists && record.data();
        if (!purchase || purchase.sessionId !== sessionId || purchase.mode !== mode ||
            !validId(purchase.albumId) || !validArchive(purchase.albumId, purchase.archivePath) ||
            !/^\d+$/.test(purchase.generation || "") || !validPrice(purchase.amount)) throw payment.denied();
        const session = await payment.stripeClient().checkout.sessions.retrieve(sessionId, {
          expand: ["line_items.data.price", "payment_intent.latest_charge"]
        });
        const lines = session.line_items && session.line_items.data;
        const intent = session.payment_intent;
        const charge = intent && intent.latest_charge;
        if (session.id !== sessionId || session.mode !== "payment" || session.status !== "complete" ||
            session.payment_status !== "paid" || session.livemode !== (mode === "live") ||
            session.currency !== "usd" || session.amount_subtotal !== purchase.amount ||
            session.amount_total !== purchase.amount || !session.metadata ||
            session.metadata.type !== "music-album-v1" || session.metadata.purchaseId !== purchaseId ||
            !Array.isArray(lines) || lines.length !== 1 || lines[0].quantity !== 1 ||
            !lines[0].price || lines[0].price.unit_amount !== purchase.amount || lines[0].price.currency !== "usd" ||
            !intent || intent.status !== "succeeded" || !charge || charge.status !== "succeeded" ||
            charge.refunded || charge.amount_refunded !== 0 || charge.disputed) throw payment.denied();
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.created > now) throw payment.denied();
        const expires = charge.created + 600;
        if (now >= expires) throw fail(payments.EXPIRED_DOWNLOAD_MESSAGE, 410);
        const file = bucket().file(purchase.archivePath, { generation: purchase.generation });
        await file.getMetadata();
        if (action === "album-purchase") return sendJson(response, 200, { title: purchase.title });
        const name = purchase.title.replace(/[^a-zA-Z0-9 ._-]+/g, "").trim().slice(0, 120) || "Wave Engine album";
        const [url] = await file.getSignedUrl({
          version: "v4", action: "read", expires: Math.min(expires * 1000, Date.now() + 60000),
          queryParams: { generation: purchase.generation },
          responseDisposition: `attachment; filename="${name}.zip"`
        });
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Location", url);
        response.writeHead(302);
        return response.end();
      }
      return sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error("Music album error:", error.message);
      return sendJson(response, error.statusCode || (error.code === 404 ? 404 : 503), {
        error: error.statusCode ? error.message :
          error.code === 404 ? "This album archive is no longer available. Please contact us for help." :
            "Album service is unavailable. Please try again later."
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.availableAlbum = availableAlbum;
