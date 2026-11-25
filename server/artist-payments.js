const crypto = require("crypto");
const Stripe = require("stripe");
const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");
const payments = require("./music-payments");
const { streamRelease, validId } = require("./artist-streaming");

function artistStripeClient() {
  const mode = payments.mode();
  const key = process.env.ARTIST_STRIPE_SECRET_KEY || "";
  if (!new RegExp(`^(sk|rk)_${mode}_`).test(key)) {
    throw new Error(`Artist Stripe ${mode} mode requires a matching ARTIST_STRIPE_SECRET_KEY.`);
  }
  return new Stripe(key);
}

const artistPayments = { ...payments, stripeClient: artistStripeClient };

function salesEnabled() {
  return process.env.ARTIST_SALES_ENABLED === "true";
}

function accountField(mode) {
  return mode === "live" ? "stripeConnectLive" : "stripeConnectTest";
}

function validPrice(value) {
  return Number.isSafeInteger(value) && value >= 50 && value <= 10000;
}

function readyAccount(account) {
  return account && account.charges_enabled === true && account.payouts_enabled === true &&
    account.controller && account.controller.fees && account.controller.fees.payer === "account";
}

function createHandler({
  database = marketplace.database,
  authenticate = marketplace.authenticate,
  bucket = marketplace.bucket,
  payment = artistPayments,
  enabled = salesEnabled
} = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
      response.writeHead(204);
      return response.end();
    }
    response.setHeader("Cache-Control", "private, no-store");
    const params = new URL(request.url, "http://localhost").searchParams;
    const action = params.get("action");
    try {
      if (!enabled() && (action === "connect" || action === "checkout")) {
        throw marketplace.statusError("Artist downloads are not available yet.", 503);
      }
      const db = database();
      const mode = payment.mode();
      const stripe = payment.stripeClient();
      const field = accountField(mode);
      if (action === "connect" && request.method === "GET") {
        const user = await authenticate(request);
        const artist = await db.collection("artists").doc(user.uid).get();
        if (!artist.exists || artist.data().status !== "approved") {
          throw marketplace.statusError("An approved artist profile is required.", 403);
        }
        const accountId = artist.data()[field];
        if (!accountId) return sendJson(response, 200, { connected: false, ready: false });
        const account = await stripe.accounts.retrieve(accountId);
        return sendJson(response, 200, { connected: true, ready: Boolean(readyAccount(account)) });
      }
      if (action === "connect" && request.method === "POST") {
        const user = await authenticate(request);
        const artistRef = db.collection("artists").doc(user.uid);
        const artist = await artistRef.get();
        if (!artist.exists || artist.data().status !== "approved") {
          throw marketplace.statusError("An approved artist profile is required.", 403);
        }
        let accountId = artist.data()[field];
        if (!accountId) {
          const account = await stripe.accounts.create({
            type: "standard",
            business_profile: { url: new URL(`artist/${encodeURIComponent(artist.data().slug)}`, payment.siteUrl()).href },
            metadata: { artistUid: user.uid }
          }, { idempotencyKey: `artist-connect-${mode}-${crypto.createHash("sha256").update(user.uid).digest("hex")}` });
          accountId = account.id;
          await db.runTransaction(async (transaction) => {
            const current = await transaction.get(artistRef);
            if (!current.exists || current.data().status !== "approved" ||
                (current.data()[field] && current.data()[field] !== accountId)) {
              throw marketplace.statusError("Artist account changed. Please refresh.", 409);
            }
            transaction.update(artistRef, { [field]: accountId });
          });
        }
        const site = payment.siteUrl();
        const link = await stripe.accountLinks.create({
          account: accountId, type: "account_onboarding",
          refresh_url: new URL("artist-dashboard?connect=refresh", site).href,
          return_url: new URL("artist-dashboard?connect=return", site).href
        });
        return sendJson(response, 200, { url: link.url });
      }
      if (action === "checkout" && request.method === "POST") {
        const { id } = await readJsonBody(request);
        if (!validId(id)) throw marketplace.statusError("Invalid artist track.", 400);
        const releaseSnapshot = await db.collection("artistReleases").doc(id).get();
        const release = releaseSnapshot.exists && releaseSnapshot.data();
        if (!release || release.status !== "published" || release.rightsConfirmed !== true ||
            release.salesRightsConfirmed !== true || !validPrice(release.downloadPriceCents) ||
            !validId(release.artistUid) || !/^\d+$/.test(release.audioGeneration || "")) {
          throw marketplace.statusError("This track is not available for purchase.", 404);
        }
        marketplace.validateReleaseInput(release.artistUid, id, release);
        const artist = await db.collection("artists").doc(release.artistUid).get();
        if (!artist.exists || artist.data().status !== "approved") {
          throw marketplace.statusError("This track is not available for purchase.", 404);
        }
        const slug = await db.collection("artistSlugs").doc(artist.data().slug).get();
        if (!slug.exists || slug.data().status !== "approved" || slug.data().artistUid !== release.artistUid) {
          throw marketplace.statusError("This track is not available for purchase.", 404);
        }
        const accountId = artist.data()[field];
        if (!accountId || !readyAccount(await stripe.accounts.retrieve(accountId))) {
          throw marketplace.statusError("This artist is not ready to accept payments.", 409);
        }
        await bucket().file(release.audioPath, { generation: release.audioGeneration }).getMetadata();
        const purchaseId = crypto.randomBytes(24).toString("hex");
        const purchaseRef = db.collection("artistPurchases").doc(purchaseId);
        const amount = release.downloadPriceCents;
        const fee = Math.round(amount / 10);
        await purchaseRef.create({
          trackId: id, artistUid: release.artistUid, accountId, mode, amount, fee,
          audioPath: release.audioPath, audioGeneration: release.audioGeneration, title: release.title,
          createdAt: marketplace.FieldValue.serverTimestamp()
        });
        const site = payment.siteUrl();
        const successUrl = new URL(`music-purchase?artist_purchase=${purchaseId}&session_id={CHECKOUT_SESSION_ID}`, site).href
          .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
        const session = await stripe.checkout.sessions.create({
          mode: "payment", payment_method_types: ["card"],
          line_items: [{ price_data: { currency: "usd", unit_amount: amount, product_data: { name: release.title } }, quantity: 1 }],
          payment_intent_data: { application_fee_amount: fee },
          metadata: { type: "artist-download-v1", purchaseId },
          custom_text: { submit: { message: "Download link expires 10 minutes after payment. Personal listening only." } },
          success_url: successUrl, cancel_url: new URL("music", site).href
        }, { stripeAccount: accountId });
        if (!session.url || session.livemode !== (mode === "live")) throw new Error("Stripe returned a session in the wrong mode.");
        await db.runTransaction(async (transaction) => {
          const purchase = await transaction.get(purchaseRef);
          if (!purchase.exists) throw new Error("Purchase record was not found.");
          transaction.update(purchaseRef, { sessionId: session.id });
        });
        return sendJson(response, 200, { url: session.url });
      }
      if ((action === "purchase" || action === "download") && request.method === "GET") {
        const purchaseId = params.get("purchase_id");
        const sessionId = params.get("session_id");
        if (!/^[a-f0-9]{48}$/.test(purchaseId || "") ||
            !new RegExp(`^cs_${mode}_[A-Za-z0-9]+$`).test(sessionId || "")) {
          throw payments.denied();
        }
        const record = await db.collection("artistPurchases").doc(purchaseId).get();
        const purchase = record.exists && record.data();
        if (!purchase || purchase.sessionId !== sessionId || purchase.mode !== mode) throw payments.denied();
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["line_items.data.price", "payment_intent.latest_charge"]
        }, { stripeAccount: purchase.accountId });
        const intent = session.payment_intent;
        const charge = intent && intent.latest_charge;
        const lines = session.line_items && session.line_items.data;
        if (session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid" ||
            session.livemode !== (mode === "live") || session.currency !== "usd" ||
            session.amount_subtotal !== purchase.amount || session.amount_total !== purchase.amount ||
            !session.metadata || session.metadata.type !== "artist-download-v1" || session.metadata.purchaseId !== purchaseId ||
            !Array.isArray(lines) || lines.length !== 1 || lines[0].quantity !== 1 ||
            !lines[0].price || lines[0].price.unit_amount !== purchase.amount || lines[0].price.currency !== "usd" ||
            !intent || intent.status !== "succeeded" || intent.application_fee_amount !== purchase.fee ||
            !charge || charge.status !== "succeeded" || charge.refunded || charge.amount_refunded !== 0 || charge.disputed) {
          throw payments.denied();
        }
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.created > now) throw payments.denied();
        if (now >= charge.created + 600) throw marketplace.statusError(payments.EXPIRED_DOWNLOAD_MESSAGE, 410);
        const release = await db.collection("artistReleases").doc(purchase.trackId).get();
        if (!release.exists || release.data().status !== "published" ||
            release.data().artistUid !== purchase.artistUid || release.data().audioPath !== purchase.audioPath ||
            release.data().audioGeneration !== purchase.audioGeneration) {
          throw marketplace.statusError("This track is no longer available. Please contact support.", 404);
        }
        if (action === "purchase") {
          return sendJson(response, 200, { title: purchase.title, format: purchase.audioPath.endsWith(".mp3") ? "mp3" : "wav" });
        }
        request.url = `/api/artist-releases?action=stream&id=${encodeURIComponent(purchase.trackId)}`;
        response.setHeader("Content-Disposition", `attachment; filename="artist-track.${purchase.audioPath.endsWith(".mp3") ? "mp3" : "wav"}"`);
        return await streamRelease(request, response, { db, bucket, authenticate, review: false });
      }
      return sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      console.error("Artist payment error:", error.message);
      return sendJson(response, error.statusCode || 503, {
        error: error.statusCode ? error.message : "Artist payments are unavailable. Please try again later."
      });
    }
  };
}

module.exports = { createHandler, salesEnabled, validPrice, artistStripeClient };
