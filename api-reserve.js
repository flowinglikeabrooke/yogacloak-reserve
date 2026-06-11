/**
 * yogacloak — /api/reserve
 *
 * POST body (JSON):
 *   { product: "cloak"|"wrap"|"both", size: "XS-M"|"L-XL"|null,
 *     firstName, lastName, email, phone }
 *
 * Returns:
 *   { url: "https://checkout.stripe.com/..." }
 *
 * Deploy on Vercel (recommended) or Netlify Functions.
 * Vercel: place this file at /api/reserve.js — zero config needed.
 * Netlify: move to /netlify/functions/reserve.js and wrap with
 *          exports.handler = async (event) => { ... body: event.body ... }
 */

import Stripe from "stripe";
import { getAvailability, decrementAvailability } from "../lib/availability.js";
import { logToSheet } from "../lib/sheets.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

// ── Stripe Price IDs ──────────────────────────────────────────────────────────
// Create these in your Stripe dashboard → Products → Add Product
// One-time prices, no recurring.
const PRICES = {
  cloak: process.env.STRIPE_PRICE_CLOAK,  // $20 deposit
  wrap:  process.env.STRIPE_PRICE_WRAP,   // $15 deposit
};

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — tighten origin to your actual domain in production
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { product, size, firstName, lastName, email, phone } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!["cloak", "wrap", "both"].includes(product)) {
      return res.status(400).json({ error: "Invalid product." });
    }
    if ((product === "cloak" || product === "both") && !["XS-M", "L-XL"].includes(size)) {
      return res.status(400).json({ error: "Cloak size required." });
    }
    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ error: "All fields required." });
    }

    // ── Check live availability ───────────────────────────────────────────────
    const availability = await getAvailability();
    if (product === "cloak" || product === "both") {
      if (availability.cloak <= 0) return res.status(409).json({ error: "The Cloak is sold out." });
    }
    if (product === "wrap" || product === "both") {
      if (availability.wrap <= 0) return res.status(409).json({ error: "The Wrap is sold out." });
    }

    // ── Build Stripe line items ───────────────────────────────────────────────
    const lineItems = [];
    if (product === "cloak" || product === "both") {
      lineItems.push({ price: PRICES.cloak, quantity: 1 });
    }
    if (product === "wrap" || product === "both") {
      lineItems.push({ price: PRICES.wrap, quantity: 1 });
    }

    // ── Create Checkout Session ───────────────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: email,
      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/#reserve`,
      metadata: {
        firstName,
        lastName,
        phone,
        product,
        size: size || "one-size",
      },
      payment_intent_data: {
        description: `YogaCloak first drop — ${product} deposit`,
        metadata: { firstName, lastName, phone, product, size: size || "one-size" },
      },
    });

    // ── Log to Google Sheet (non-blocking) ───────────────────────────────────
    logToSheet({
      timestamp: new Date().toISOString(),
      firstName,
      lastName,
      email,
      phone,
      product,
      size: size || "one-size",
      depositAmount: lineItems.reduce((sum, li) => {
        return sum + (li.price === PRICES.cloak ? 20 : 15);
      }, 0),
      stripeSessionId: session.id,
      status: "pending",
    }).catch((err) => console.error("Sheet log failed (non-fatal):", err));

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("Reserve error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
