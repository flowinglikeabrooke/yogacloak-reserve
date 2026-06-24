import Stripe from "stripe";
import { logToSheet } from "./lib-sheets.js";
import { getAvailability } from "./lib-availability.js";

const stripe = new Stripe(process.env.RESERVE_STRIPE_SECRET_KEY, {
    apiVersion: "2024-04-10",
});

const PRICES = {
    cloak: process.env.RESERVE_STRIPE_PRICE_CLOAK,
    wrap: process.env.RESERVE_STRIPE_PRICE_WRAP,
};

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  const body = req.body || {};

  // Normalize field names — frontend sends snake_case, support both
  const firstName = body.firstName || body.first_name || "";
    const lastName = body.lastName || body.last_name || "";
    const email = body.email || "";
    const phone = body.phone || "";
    const size = body.size || "";

  // Normalize product — frontend sends products[] array OR product string
  let product;
    if (Array.isArray(body.products)) {
          const has = (k) => body.products.includes(k);
          if (has("cloak") && has("wrap")) product = "both";
          else if (has("cloak")) product = "cloak";
          else if (has("wrap")) product = "wrap";
    } else {
          product = body.product || "";
    }

  // Validate
  if (!["cloak", "wrap", "both"].includes(product)) {
        return res.status(400).json({ error: "Invalid product selection." });
  }
    if (!firstName || !lastName) return res.status(400).json({ error: "Name is required." });
    if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email is required." });
    if ((product === "cloak" || product === "both") && !size) {
          return res.status(400).json({ error: "Size is required for the cloak." });
    }

  // Check availability before creating Stripe session
  try {
        const avail = await getAvailability();
        if ((product === "cloak" || product === "both") && avail.cloak <= 0) {
                return res.status(400).json({ error: "The Cloak is sold out for the first drop." });
        }
        if ((product === "wrap" || product === "both") && avail.wrap <= 0) {
                return res.status(400).json({ error: "The Wrap is sold out for the first drop." });
        }
  } catch (err) {
        console.error("Availability check failed (non-blocking):", err);
        // Don't block checkout if KV is temporarily unavailable
  }

  // Build Stripe line items
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
                success_url: siteUrl + "/success?product=" + product,
                cancel_url: siteUrl + "/reserve?status=cancelled",
                metadata: { product, size, firstName, lastName, email, phone },
        });

      // Log to Google Sheet (non-blocking)
      try {
              await logToSheet({
                        stripeSessionId: session.id,
                        product,
                        size,
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
