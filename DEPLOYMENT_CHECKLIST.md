# YogaCloak Deployment Checklist

## Pre-Deploy
- [ ] Review all files in outputs folder
- [ ] Verify deposit amounts are **Cloak $20, Wrap $15** (updated June 20)
- [ ] Check reserve page headline "What are you taking home?" (unchanged ✓)
- [ ] Confirm reserve page has cheeky tone, not corporate ✓

## Upload Files

### HTML
- [ ] Rename `yogacloak-index.html` → `yogacloak-index-backup-2026-06-19.html`
- [ ] Upload `yogacloak-index-revised.html` as `yogacloak-index.html`
- [ ] Upload `yogacloak-reserve-page-refined.html` as `yogacloak-reserve-page.html`

### JavaScript
- [ ] Create `/main.js` from uploaded file
- [ ] Create `/main-reserve.js` from uploaded file

### Fonts (Optional but Recommended)
- [ ] Create `/fonts/` directory
- [ ] Download Hanken Grotesk from Google Fonts
- [ ] Upload `/fonts/hanken-grotesk-400.woff2`
- [ ] Upload `/fonts/hanken-grotesk-600.woff2`

### Images (Responsive Optimization Required)
- [ ] hero-duo: 480w.webp, 900w.webp, 1600w.webp, 900w.jpg (fallback)
- [ ] cloak-card: 480w.webp, 900w.webp, 900w.jpg
- [ ] wrap-card: 480w.webp, 900w.webp, 900w.jpg
- [ ] studio-to-street: 480w.webp, 900w.webp, 1600w.webp, 900w.jpg
- [ ] material: 480w.webp, 900w.webp, 1600w.webp, 900w.jpg
- [ ] Gallery (9 images): each 480w.webp, 900w.webp, 900w.jpg

## Vercel Configuration
- [ ] Set `DEPOSIT_CLOAK=20` (was 25)
- [ ] Set `DEPOSIT_WRAP=15` (was 20)
- [ ] Verify `STRIPE_PRICE_CLOAK` and `STRIPE_PRICE_WRAP` are set to live price IDs
- [ ] Verify `/api/reserve` endpoint exists and reads env vars
- [ ] Verify `/api/subscribe` endpoint exists (or create it)

## Test Landing Page (Live)
- [ ] Modal does NOT auto-trigger ✓ (only on CTA band button click)
- [ ] CTA band visible between fabric section and closing section ✓
- [ ] "Be the first to know" button opens modal ✓
- [ ] Modal closes on X, Esc, backdrop click ✓
- [ ] Form: first name, last name, email fields appear ✓
- [ ] Float "Reserve yours" pill appears after scrolling hero ✓
- [ ] Float pill hides when closing section visible ✓
- [ ] All links work: home, FAQ, reserve buttons ✓

## Test Reserve Page (Live)
- [ ] Headline: "What are you taking home?" ✓
- [ ] Subtitle appears: "A small deposit saves your spot..." ✓
- [ ] Product cards show:
  - [ ] Cloak: "$98" / "$20 deposit" / "I'll Take the Cloak" button
  - [ ] Wrap: "$68" / "$15 deposit" / "I'll Take the Wrap" button
  - [ ] Both: "First drop: 100 pieces" ✓
- [ ] Disclaimer visible: "Reservation deposit only..." ✓
- [ ] Clicking product button opens form ✓
- [ ] Form shows: first, last, email, (size if Cloak) ✓
- [ ] Deposit summary shows correct amounts ✓
- [ ] "Pay deposit & reserve" button POSTs to `/api/reserve` ✓
- [ ] User redirected to Stripe checkout ✓
- [ ] Dark, minimal, cheeky tone maintained ✓

## Performance Testing (Post-Deploy)

### Google PageSpeed Insights (Mobile)
- [ ] FCP: ___s (target: <1.5s)
- [ ] LCP: ___s (target: <2.5s)
- [ ] CLS: ___ (target: <0.1)
- [ ] Performance score: ___ (target: >85)

### Chrome DevTools Throttling (4G, iPhone 12)
- [ ] Page loads in: ___s (target: <3s)
- [ ] No scroll jank ✓
- [ ] Modal opens instantly ✓
- [ ] Form submits without lag ✓

### Vercel Analytics
- [ ] TTFB: ___ms
- [ ] Avg FCP: ___ms
- [ ] CLS: ___
- [ ] Compare vs. pre-optimization baseline

## Post-Deploy Actions
- [ ] Roll Stripe sk_live key (if exposed)
- [ ] Set live Stripe webhook secret in Vercel env
- [ ] Build `/api/subscribe` (for popup phone capture)
- [ ] Wire `/api/availability` counts to Vercel KV
- [ ] Update success page (copy + wordmark + design)
- [ ] Fix API routing gap for session fetch
- [ ] Record Lighthouse scores in OPTIMIZATION_REVISED_CHANGELOG.md "Tested Gains" section

## Rollback Plan
If performance regresses or bugs appear:
1. Revert `yogacloak-index.html` to backup
2. Delete `/main.js` from Vercel (reload uses backup HTML)
3. Revert `yogacloak-reserve-page.html` to prior version
4. Investigate in outputs folder files for issues
5. Re-upload corrected files

## Notes
- Font self-hosting is optional but improves FCP by ~200ms
- If image optimization takes time, deploy without WebP (use JPGs only) and optimize after
- Modal on-click respects brand; no aggressive auto-popups ✓
- Reserve page deposit copy is minimal but clear ✓
- All design + tone preserved; only performance + clarity added ✓

