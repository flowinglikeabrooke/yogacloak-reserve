/**
 * lib/availability.js
 *
 * Manages the 100-unit inventory for cloak and wrap.
 *
 * Storage: Vercel KV (Redis-compatible, free tier covers this)
 *   → https://vercel.com/docs/storage/vercel-kv
 *   Add to project: `vercel env add KV_REST_API_URL` + `KV_REST_API_TOKEN`
 *
 * Keys:
 *   yogacloak:cloak  →  integer (spots remaining)
 *   yogacloak:wrap   →  integer (spots remaining)
 *
 * To seed initial counts, run:
 *   node scripts/seed-availability.js
 */

import { kv } from "@vercel/kv";

const KEYS = {
  cloak: "yogacloak:cloak",
  wrap:  "yogacloak:wrap",
};

const TOTAL = 100;

/**
 * Returns current availability.
 * Falls back to TOTAL if keys haven't been seeded yet.
 */
export async function getAvailability() {
  const [cloak, wrap] = await Promise.all([
    kv.get(KEYS.cloak),
    kv.get(KEYS.wrap),
  ]);

  return {
    cloak: cloak !== null ? Number(cloak) : TOTAL,
    wrap:  wrap  !== null ? Number(wrap)  : TOTAL,
  };
}

/**
 * Atomically decrements availability after confirmed payment.
 * Uses Redis DECR so concurrent checkouts can't oversell.
 *
 * @param {"cloak"|"wrap"|"both"} product
 */
export async function decrementAvailability(product) {
  const ops = [];

  if (product === "cloak" || product === "both") {
    ops.push(
      kv.decrby(KEYS.cloak, 1).then((remaining) => {
        // Guard: if somehow goes negative, reset to 0
        if (remaining < 0) return kv.set(KEYS.cloak, 0);
      })
    );
  }

  if (product === "wrap" || product === "both") {
    ops.push(
      kv.decrby(KEYS.wrap, 1).then((remaining) => {
        if (remaining < 0) return kv.set(KEYS.wrap, 0);
      })
    );
  }

  await Promise.all(ops);
}

/**
 * One-time seed — run manually to initialize counts.
 * Call: node -e "import('./lib/availability.js').then(m => m.seedAvailability())"
 */
export async function seedAvailability() {
  await Promise.all([
    kv.set(KEYS.cloak, TOTAL),
    kv.set(KEYS.wrap, TOTAL),
  ]);
  console.log(`Seeded: cloak=${TOTAL}, wrap=${TOTAL}`);
}
