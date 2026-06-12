import { getAvailability } from "../lib-availability.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") return res.status(405).end();

  try {
    const counts = await getAvailability();
    return res.status(200).json(counts);
  } catch (err) {
    console.error("Availability fetch error:", err);
    return res.status(500).json({ error: "Could not fetch availability." });
  }
}
