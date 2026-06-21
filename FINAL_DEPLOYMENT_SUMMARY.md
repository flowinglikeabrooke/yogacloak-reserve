# YogaCloak Site Optimization & Reserve Page Refinement — Final Delivery

**Date:** June 20, 2026  
**Status:** Ready for deployment

---

## Deliverables

### 1. Landing Page (Optimized)
**File:** `yogacloak-index-revised.html` (24 KB)
- External JS: references `/main.js`
- Font preload setup for self-hosted `.woff2` (weights 400, 600)
- Lazy-loaded product card images
- Removed auto-popup; replaced with embedded CTA band ("Be the first to know")
- Modal triggers on button click only (respects premium brand feel)
- Removed broad `will-change` from static images
- IntersectionObserver threshold: 0.2 (20% visible)
- All visuals unchanged; same design, faster load

### 2. Landing Page JavaScript
**File:** `main.js` (2.3 KB)
- Handles: topbar scroll detection, float reserve button, reveal animations, modal logic
- No parallax calculations
- No render-blocking

### 3. Reserve Page (Refined)
**File:** `yogacloak-reserve-page-refined.html` (13 KB)
- Headline: "What are you taking home?" (unchanged)
- New subtitle under hero: "A small deposit saves your spot in the first drop. Estimated ship window: November 2027."
- Updated product cards:
  - **The Cloak:** "For the drive home" / "First drop: 100 pieces" / $98 / $20 deposit / "I'll Take the Cloak"
  - **The Wrap:** "For the walk home" / "First drop: 100 pieces" / $68 / $15 deposit / "I'll Take the Wrap"
- Tiny disclaimer: "Reservation deposit only. Applied toward your final order."
- Dark, minimal, cheeky tone — not corporate
- Lazy-loaded product images

### 4. Reserve Page JavaScript
**File:** `main-reserve.js` (2 KB)
- Handles: product selection, form state management, Stripe checkout POST
- Click-to-action flow (no auto-triggers)

### 5. Technical Documentation
**File:** `OPTIMIZATION_REVISED_CHANGELOG.md` (9.8 KB)
- Complete technical spec with revisions applied
- Post-deployment testing criteria
- Self-hosting font recommendations
- Estimated vs. tested performance gains (template for real Lighthouse results)

---

## Deposit Amounts (Corrected June 20)

| Product | Price | Deposit |
|---------|-------|---------|
| The Cloak | $98 | **$20** |
| The Wrap | $68 | **$15** |

**Policy:** Non-refundable, transferable, applied to final price.

---

## Deployment Steps

### 1. Upload HTML Files
```
yogacloak-index.html ← yogacloak-index-revised.html
yogacloak-reserve-page.html ← yogacloak-reserve-page-refined.html
```

### 2. Upload JavaScript Files
```
/main.js (from main.js)
/main-reserve.js (from main-reserve.js)
```

### 3. Fonts (Self-Host – Recommended)
Create `/fonts/` directory and add:
```
/fonts/hanken-grotesk-400.woff2
/fonts/hanken-grotesk-600.woff2
```
Download from: https://fonts.google.com/specimen/Hanken+Grotesk

If skipping self-hosting: keep Google Fonts CDN link in HTML (works fine, ~100–200ms slower).

### 4. Upload Optimized Images
**Responsive sizing required:** 3 sizes per image (WebP + JPG fallback)

Hero:
- hero-duo-480w.webp, hero-duo-900w.webp, hero-duo-1600w.webp
- hero-duo-900w.jpg

Product Cards (Cloak & Wrap):
- cloak-card-480w.webp, cloak-card-900w.webp, cloak-card-900w.jpg
- wrap-card-480w.webp, wrap-card-900w.webp, wrap-card-900w.jpg

Editorial (studio-to-street, material):
- studio-to-street-480w.webp, -900w.webp, -1600w.webp, -900w.jpg
- material-480w.webp, -900w.webp, -1600w.webp, -900w.jpg

Gallery (9 images, all responsive):
- gal-az-vista, gal-wrap-nyc, gal-az-garage, gal-group-walk, gal-mat-desert, gal-stairs-duo, gal-fabric, gal-couple-elevator, gal-cloak-hook
- Each: 480w.webp, 900w.webp, 900w.jpg

### 5. Update Vercel Environment Variables
Set deposit amounts in `vercel.json` or env:
```
DEPOSIT_CLOAK=20
DEPOSIT_WRAP=15
```

### 6. Test Live
- Google PageSpeed Insights (mobile, desktop)
- Chrome DevTools throttling (4G, iPhone 12)
- Verify modal triggers on CTA button click (not auto)
- Verify form POSTs to `/api/reserve`
- Verify reserve page displays correct deposit amounts

### 7. Monitor & Document
- Record Lighthouse scores (FCP, LCP, CLS)
- Compare vs. estimated gains in changelog
- Update "Tested Gains" section with real results

---

## Performance Expectations

### Estimated (Pre-Deploy)
- **FCP:** 2.8–3.2s → 1.0–1.2s (2.0–2.2s faster)
- **LCP:** 3.8–4.2s → 1.8–2.0s (2.0–2.4s faster)
- **CLS:** 0.08 → 0.02 (75% improvement)
- **Page Size:** ~800KB → ~520KB (35% reduction)

### To Be Tested (Post-Deploy)
Run Lighthouse after deploying and fill in:
- [ ] FCP: ___ s (target: <1.5s)
- [ ] LCP: ___ s (target: <2.5s)
- [ ] CLS: ___ (target: <0.1)
- [ ] Mobile Lighthouse score: ___ (target: >85)

---

## What Stayed the Same

✓ All visual design (colors, typography, spacing)  
✓ All HTML structure  
✓ All interactive behaviors (hover states, animations)  
✓ All CTAs and links  
✓ Landing page message  
✓ Reserve page headline "What are you taking home?"  
✓ Dark, minimal, premium brand feel  

---

## Key Technical Changes

### Landing Page
1. JS moved to external `/main.js` (proper deferral)
2. Font preload for self-hosted woff2 (optional but recommended)
3. Removed broad `will-change` from static images
4. Product cards lazy-loaded (below-fold on mobile)
5. Removed auto-popup; added embedded CTA band
6. Modal opens on button click only
7. IntersectionObserver threshold 0.2 (20% visible)

### Reserve Page
1. Added deposit context below headline
2. Corrected deposit amounts: Cloak $20, Wrap $15
3. Added "First drop: 100 pieces" to product cards
4. Updated button copy to "I'll Take the Cloak/Wrap"
5. Added tiny disclaimer under cards
6. Kept dark, cheeky tone

---

## Files Ready to Upload (In Outputs Folder)

- ✅ yogacloak-index-revised.html
- ✅ main.js
- ✅ yogacloak-reserve-page-refined.html
- ✅ main-reserve.js
- ✅ OPTIMIZATION_REVISED_CHANGELOG.md
- ✅ FINAL_DEPLOYMENT_SUMMARY.md (this file)

---

## Next Steps (After Deploy)

1. Roll Stripe sk_live key (if exposed in chat)
2. Set live Stripe webhook secret + SITE_URL in Vercel env
3. Build `/api/subscribe` to persist popup phone numbers
4. Wire live `/api/availability` counts
5. Update success page copy + wordmark to match new design
6. Fix API routing gap (success page session fetch)
7. Run Lighthouse → update tested gains

---

## Notes

- **Font self-hosting:** Improves FCP by ~200ms. Google Fonts CDN works as fallback.
- **Modal on click:** Better UX, higher conversion. Respects premium brand positioning.
- **Lazy images:** Safe because product cards are well below fold on mobile.
- **CTA band:** Branded, atmospheric, intentional—no aggressive auto-triggers.
- **Responsive images:** 3 sizes (480w, 900w, 1600w) for mobile, tablet, desktop optimization.

---

## Questions or Issues?

- Landing page loads slowly? Check image optimization (WebP conversion, srcset validity).
- Modal not opening? Verify `/main.js` loads and button ID matches ("ctaBtnOpen").
- Reserve page not posting? Check `/api/reserve` endpoint + Stripe keys in env.
- Font not loading? Check `/fonts/` directory exists + woff2 files uploaded.

