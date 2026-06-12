/**
 * yogacloak — /api/reserve
 *
 * POST { product: "cloak"|"wrap"|"both", size, firstName, lastName, email, phone }
 *   → creates a Stripe Checkout session for the deposit(s)
 *   → logs a "pending" row to the Google Sheet
 *   → returns { url } for the frontend to redirect to
 *
 * The webhook (/api/webhook) flips the row to "confirmed" and
 * decrements availability once checkout.session.completed fires.
 */

import Stripe from "stripe";
import { logToSheet } from "./lib-sheets.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

const PRICES = {
  cloak: process.env.STRIPE_PRICE_CLOAK,
  wrap: process.env.STRIPE_PRICE_WRAP,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  const { product, size, firstName, lastName, email, phone } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────
  if (!["cloak", "wrap", "both"].includes(product)) {
    return res.status(400).json({ error: "Invalid product selection." });
  }
  if (!firstName || !lastName) return res.status(400).json({ error: "Name is required." });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email is required." });
  if (!phone) return res.status(400).json({ error: "Phone is required." });
  if ((product === "cloak" || product === "both") && !size) {
    return res.status(400).json({ error: "Size is required for the cloak." });
  }

  // ── Build line items ────────────────────────────────────────────────────
  const lineItems = [];
  if (product === "cloak" || product === "both") {
    lineItems.push({ price: PRICES.cloak, quantity: 1 });
  }
  if (product === "wrap" || product === "both") {
    lineItems.push({ price: PRICES.wrap, quantity: 1 });
  }

  const siteUrl = process.env.SITE_URL || "https://yogacloak-reserve.vercel.app";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: email,
      success_url: `${siteUrl}/reserve?status=confirmed`,
      cancel_url: `${siteUrl}/reserve?status=cancelled`,
      metadata: {
        product,
        size: size || "",
        firstName,
        lastName,
        email,
        phone,
      },
    });

    // Log a pending row — webhook will flip it to "confirmed"
    try {
      await logToSheet({
        stripeSessionId: session.id,
        product,
        size: size || "",
        firstName,
        lastName,
        email,
        phone,
        status: "pending",
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Sheet log failed (non-blocking):", err);
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout creation failed:", err);
    return res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
}
