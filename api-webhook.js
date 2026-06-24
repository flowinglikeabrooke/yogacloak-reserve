/**
 * yogacloak — /api/webhook
 *
 * Stripe sends a checkout.session.completed event here after payment.
 * This is where we:
 *   1. Decrement live availability counts
 *   2. Update the Google Sheet row status to "confirmed"
 *
 * Register this URL in your Stripe dashboard:
 *   Developers → Webhooks → Add endpoint
 *   URL: https://your-domain.com/api/webhook
 *   Events: checkout.session.completed
 */

import Stripe from "stripe";
import { decrementAvailability } from "./lib-availability.js";
import { updateSheetStatus } from "./lib-sheets.js";

const stripe = new Stripe(process.env.RESERVE_STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

export const config = { api: { bodyParser: false } }; // Vercel: raw body needed

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.RESERVE_STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { product, size, firstName, lastName, phone } = session.metadata;

    // 1. Decrement availability counts
    try {
      await decrementAvailability(product);
    } catch (err) {
      console.error("Availability decrement failed:", err);
      // Don't block — log and continue
    }

    // 2. Update Google Sheet row to "confirmed"
    try {
      await updateSheetStatus(session.id, "confirmed");
    } catch (err) {
      console.error("Sheet status update failed:", err);
    }

    console.log(`✅ Confirmed reservation: ${firstName} ${lastName} — ${product}`);
  }

  res.status(200).json({ received: true });
}
