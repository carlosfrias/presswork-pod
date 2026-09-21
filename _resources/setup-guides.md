---
title: Presswork POD — Setup Guides
date: 2026-09-08
status: active
---

# Presswork POD — Setup Guides

> Step-by-step guides for setting up the three accounts needed before the Presswork pipeline can run: Etsy, Printify, and fal.ai.

---

## 1. Etsy Shop Setup

### What It Is
Etsy is the marketplace where your POD products are listed and sold. It's the storefront customers see. Printify handles the printing and shipping, but Etsy handles the listing, payment, and customer-facing experience.

### Costs

| Fee | Amount | When Charged |
|-----|--------|--------------|
| **Setup fee** | $15 (one-time) | When you open your shop |
| **Listing fee** | $0.20 per listing | Every 4 months, or when a listing sells and auto-renews |
| **Transaction fee** | 6.5% | On every sale (item price + shipping + gift wrap) |
| **Payment processing** | 3% + $0.25 | On every sale (US; varies by country) |
| **Offsite ads** | 15% of attributed order | Only if a sale comes through an Etsy ad (opt-out if under $10K sales/year) |

**Example:** You sell a t-shirt for $24.99 with free shipping:
- Listing fee: $0.20
- Transaction fee: $24.99 × 6.5% = $1.62
- Payment processing: $24.99 × 3% + $0.25 = $1.00
- **Total Etsy fees per sale: ~$2.82**
- **Your net before product cost: $24.99 - $2.82 = $22.17**
- **Product cost (Printify): ~$8.50 + $4.50 shipping = $13.00**
- **Your profit: ~$9.17 (36.7%)**

### What You Need to Open an Etsy Shop

1. **Email address** — Google or any email works
2. **Bank account or debit/credit card** — For receiving payments and paying fees
3. **Government-issued ID** — For identity verification (driver's license, passport, or state ID)
4. **A profile photo** — Headshot or logo
5. **Shop name** — This becomes your URL: `etsy.com/shop/YOURSHOPNAME`
6. **$15 for the setup fee** — Charged when you open the shop

### Step-by-Step Setup

1. **Go to [etsy.com/sell](https://www.etsy.com/sell)** and click "Get started"
2. **Sign up or sign in** — Create an Etsy account or use an existing one
3. **Set shop preferences** — Language, country, currency
4. **Name your shop** — Choose something memorable. You can change it later (once). For Presswork, consider a generic POD shop name since the agents generate the listings
5. **Add listings** — You need at least 1 listing to open, but the Presswork pipeline will create these. For now, add a placeholder listing (a single digital download for $0.01 is fine)
6. **Set up payment** — Enter your bank account details for payouts. Etsy deposits funds every Friday for US sellers
7. **Verify your identity** — Upload a photo of your government-issued ID
8. **Set up billing** — Add a credit/debit card for fees. Etsy charges fees as they accrue
9. **Add a production partner** — This is critical for POD. Go to Shop Manager → Settings → Production Partners → Add a partner → Select "Another company or person" → Enter Printify's details (the Presswork pipeline handles this, but you can add it manually too)
10. **Enable Etsy API access** — This is what the Presswork Listing agent needs. Go to [etsy.com/developers/register](https://www.etsy.com/developers/register) to create a developer app

### Critical: Etsy Developer App Setup (For Presswork)

The Presswork Listing agent needs Etsy API credentials to create and manage listings programmatically.

1. **Go to [etsy.com/developers/register](https://www.etsy.com/developers/register)**
2. **Create a new app** — Fill in:
   - App Name: `presswork-pod` (or whatever you prefer)
   - Description: "Automated print-on-demand pipeline for Etsy"
   - Website: Your Etsy shop URL
   - Redirect URI: `http://localhost:3000/callback` (for initial OAuth flow)
3. **Get your credentials:**
   - `ETSY_API_KEY` (key string) — shown on the app details page
   - `ETSY_API_SECRET` (shared secret) — shown on the app details page
4. **Set up OAuth tokens:**
   - Run the Presswork OAuth flow (the dashboard has a button for this)
   - This generates `ETSY_ACCESS_TOKEN` and `ETSY_REFRESH_TOKEN`
   - **Important:** Access tokens expire every 1 hour. The Presswork code handles refresh automatically
5. **Get your `ETSY_SHOP_ID`:**
   - Go to your Etsy shop page
   - The shop ID is in the URL or can be retrieved via the API

### Important Notes for POD Sellers

- **AI disclosure is mandatory.** Etsy requires you to disclose AI-generated content. The Presswork pipeline includes this automatically in every listing description
- **Production partner disclosure is mandatory.** You must declare that Printify produces your items. The Presswork pipeline sets this automatically
- **You cannot claim "handmade"** for POD items. Listings must say "made to order" and "i_did" (you designed it, Printify made it)
- **Etsy may flag mass-produced listings.** Start with 5-10 listings per day and increase gradually. Don't flood the platform with 100 listings on day 1

---

## 2. Printify Account Setup

### What It Is
Printify is a print-on-demand fulfillment platform. They handle printing, packaging, and shipping your products directly to customers. When an order comes in on Etsy, Printify prints the item and ships it — you never touch inventory.

**Printify vs Printful:**
- Printify is a **marketplace** — they connect you with multiple print providers (90+). You choose which provider prints each product. This gives you more options and often lower prices, but quality varies by provider.
- Printful is a **single provider** — they own their facilities. More consistent quality, but higher prices and fewer product options.
- **For Presswork, Printify is the right choice** because: the pipeline already integrates with Printify's API, prices are lower (especially on the Premium plan), and product variety is greater.

### Costs

| Plan | Price | Products | Discount | Stores |
|------|-------|----------|----------|--------|
| **Free** | $0/month | Unlimited designs | No discount | 5 stores |
| **Premium** | $39/month (or $24.99/month billed yearly) | Unlimited designs | Up to 20% off all products | 10 stores |
| **Enterprise** | Custom pricing | Unlimited designs | Up to 33% off + custom branding | Unlimited stores |

**For Presswork, start with the Free plan.** Upgrade to Premium only when your monthly sales justify the $24.99-39/month cost. The 20% discount saves you ~$1.70 per t-shirt, so you need about 15 sales/month to break even on Premium.

### Product Costs (Gildan 64000 T-Shirt — Most Popular)

| Plan | Printify Cost | Shipping (US) | Your Price | Etsy Fees | Your Profit |
|------|--------------|---------------|-----------|-----------|-------------|
| **Free** | ~$8.95 | ~$4.50 | $24.99 | ~$2.82 | ~$8.72 (34.9%) |
| **Premium** | ~$7.16 (20% off) | ~$4.50 | $24.99 | ~$2.82 | ~$10.51 (42.1%) |

### Step-by-Step Setup

1. **Go to [printify.com](https://printify.com/) and click "Get started for free"**
2. **Create an account** — Sign up with email, Google, or Facebook
3. **Verify your email** — Check your inbox and click the confirmation link
4. **Complete your profile** — Add your business name and shipping origin (US default)
5. **Browse the product catalog** — You don't need to add products yet (Presswork does this), but familiarize yourself with:
   - **T-shirts:** Gildan 64000 ($8.95 free / $7.16 premium) — the most popular POD item
   - **Mugs:** 11oz ceramic mug (~$5.50 free / $4.40 premium) — great margins
   - **Posters:** Various sizes from ~$3-8 — lightweight, cheap to ship
6. **Connect your Etsy shop** — Go to My Stores → Add Store → Etsy → Follow the OAuth flow. This authorizes Printify to:
   - Automatically fulfill orders placed on your Etsy shop
   - Push product listings to Etsy
   - Update tracking numbers on Etsy orders
7. **Set up shipping** — Printify handles shipping rates, but you should configure:
   - Free shipping on orders over $35 (common Etsy strategy)
   - Or build shipping into the product price and offer "free shipping" (Presswork does this)

### What Presswork Needs From Printify

- `PRINTIFY_API_TOKEN` — Found in Printify Dashboard → Account → API Keys → Create New Token
- `PRINTIFY_SHOP_ID` — Found in the URL when viewing your Printify shop: `printify.com/app/shop/{SHOP_ID}`
- `ETSY_PRODUCTION_PARTNER_ID` — The ID of your Printify production partner on Etsy. The Presswork pipeline retrieves this during setup

### Important Notes

- **Printify has no minimum orders.** You can sell 1 t-shirt or 1000.
- **Printify handles returns.** For POD, returns are rare since items are made to order
- **Product quality varies by provider.** Stick with the top-rated providers (Bella+Canvas, Gildan, Next Level)
- **Mugs and posters have different margins than t-shirts.** Mugs cost ~$5.50 to print but sell for $15-25 (60-70% margin). Posters cost ~$3-8 and sell for $15-30 (60-75% margin)

---

## 3. fal.ai API Key Setup

### What It Is
fal.ai is the image generation service Presswork uses to create product designs. It provides access to FLUX Pro 1.1, GPT Image 2, and other AI image models via API. The Design agent calls fal.ai to generate print-ready 300dpi PNGs from Claude-generated prompts.

### Costs

| Model | Cost | Quality | Speed |
|-------|------|---------|-------|
| **FLUX Pro 1.1** | $0.04/image | Best | ~10 sec |
| **FLUX Pro 1.1 Ultra** | $0.06/image | Best, up to 2K | ~15 sec |
| **GPT Image 2** | ~$0.02-0.04/image | Good | ~8 sec |
| **Nano Banana (Gemini)** | ~$0.01/image | Decent | ~5 sec |

**For Presswork, start with FLUX Pro 1.1** at $0.04/image. The Presswork pipeline supports all three models and allows per-brief model selection via the `image_model` field.

**Monthly cost estimate:**
- 5 designs/day × 50 variations = 250 images/month
- 250 × $0.04 = **$10/month in image generation**
- 250 × $0.01 (Claude for prompts) = **$2.50/month in Claude API**
- **Total AI cost: ~$12.50/month** for 250 designs

### Step-by-Step Setup

1. **Go to [fal.ai](https://fal.ai/) and click "Sign up"**
2. **Create an account** — Sign up with Google, GitHub, or email
3. **Add billing/credits:**
   - Go to Dashboard → Billing
   - Add a credit card
   - **Add credits** — Start with $20 (covers ~500 images at FLUX Pro rates)
   - Credits expire 365 days after purchase
   - **Note on free credits:** fal.ai occasionally offers free credits in the Sandbox/Playground, but these CANNOT be used for API calls. You need paid credits for the Presswork pipeline
4. **Create an API key:**
   - Go to Dashboard → Keys ([fal.ai/dashboard/keys](https://fal.ai/dashboard/keys))
   - Click "Create new key"
   - **Scope: API** — This is all the Presswork pipeline needs (calling models and deployed endpoints)
   - **Name it:** `presswork-design-agent` (or whatever you prefer)
   - **Copy the key immediately** — It's shown only once
5. **Set the environment variable:**
   ```bash
   export FAL_KEY="your-api-key-here"
   ```
   Or add it to your `.env` file in the Presswork project

### Testing Your Key

Run a quick test to verify the key works:

```python
import fal_client

result = fal_client.submit(
    "fal-ai/flux-pro/v1.1",
    arguments={
        "prompt": "A cute whimsical cartoon pig in a farm setting, flat design, bold colors, transparent background",
        "image_size": "square_hd",
    },
)
print(result.get())
```

If you get a response with an image URL, the key is working.

### Important Notes

- **You are only charged for successful outputs.** Server errors and queue wait times are not billed
- **fal.ai has rate limits.** The Presswork pipeline respects these automatically (4 concurrent requests, 110ms minimum between requests)
- **Image generation takes 5-15 seconds per image.** The Design agent polls for completion
- **The pipeline uses SHA-256 deduplication.** If the same prompt is generated twice, it reuses the previous image instead of paying for a duplicate

---

## Quick-Start Checklist

Before the Presswork pipeline can run, you need:

| Step | Service | Action | Time | Cost |
|------|---------|--------|------|------|
| 1 | **Etsy** | Create seller account | 15 min | $15 setup |
| 2 | **Etsy** | Add production partner (Printify) | 5 min | $0 |
| 3 | **Etsy** | Create developer app for API access | 10 min | $0 |
| 4 | **Etsy** | Get OAuth tokens (via Presswork dashboard) | 10 min | $0 |
| 5 | **Printify** | Create account | 5 min | $0 (free plan) |
| 6 | **Printify** | Connect to Etsy shop | 10 min | $0 |
| 7 | **Printify** | Get API token and shop ID | 5 min | $0 |
| 8 | **fal.ai** | Create account | 5 min | $0 |
| 9 | **fal.ai** | Add $20 credits | 5 min | $20 |
| 10 | **fal.ai** | Create API key | 2 min | $0 |
| 11 | **Presswork** | Fork repo, configure env vars | 15 min | $0 |
| 12 | **Presswork** | Run local test with mock APIs | 30 min | $0 |
| **Total** | | | **~1.5 hours** | **~$35** |

### Environment Variables Needed

```bash
# Etsy
ETSY_API_KEY=your_etsy_api_key
ETSY_API_SECRET=your_etsy_api_secret
ETSY_SHOP_ID=your_etsy_shop_id
ETSY_ACCESS_TOKEN=your_oauth_access_token
ETSY_REFRESH_TOKEN=your_oauth_refresh_token
ETSY_PRODUCTION_PARTNER_ID=your_printify_partner_id_on_etsy

# Printify
PRINTIFY_API_TOKEN=your_printify_api_token
PRINTIFY_SHOP_ID=your_printify_shop_id

# fal.ai
FAL_KEY=your_fal_api_key

# AI (Claude)
ANTHROPIC_API_KEY=your_anthropic_api_key

# Database (Supabase on fnet3)
SUPABASE_URL=http://192.168.0.143:5432
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_ANON_KEY=your_supabase_anon_key

# Dashboard
DASHBOARD_ALLOWED_EMAILS=your_email@example.com
DASHBOARD_LOCAL_TRIGGERS_ENABLED=true

# Alerts (optional but recommended)
SLACK_WEBHOOK_URL=your_slack_webhook_url
RESEND_API_KEY=your_resend_api_key
ALERT_EMAIL=your_email@example.com
```

---

*Last updated: 2026-09-08 · Complete setup guides for Etsy, Printify, and fal.ai.*