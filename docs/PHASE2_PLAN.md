# FinderNate Phase 2: Development Plan

Prepared 3 Nov 2026 from *Phase 2 features (final).pdf* and a review of the current code in all three repos:

- `FinderNate-Backend`: Node.js / Express / MongoDB API
- `findernate-frontend`: Next.js website
- `findernate-app`: Flutter app, currently v4.9.13

---

## 1. Summary

- **75 items** are listed in the PDF.
  - #39 and #43 are blacked out.
  - #60, #67 and #69 are missing.
  - #76 repeats #75 word for word.
  - #50 and #57 describe the same feature (collab for video and for photo).
- **Status today:**

  | Status | Count |
  |---|---|
  | Essentially done, only needs checking | 2 |
  | Bug fix | 1 |
  | Partly built | 32 |
  | New | 39 |
  | Duplicate | 1 |

  The codebase already has many of the building blocks: nested comments, a drafts model, view tracking, plan boosts, subscription reminders, admin KYC review, adaptive video renditions from Bunny, and story replies.
- **Six areas need an outside service or a buying decision:**
  - KYC verification API (GST / PAN / Aadhaar)
  - GIF and sticker API
  - Music licensing
  - Video-editing toolkit (plus an AR SDK only if you want face filters)
  - AI image API
  - A bulk email provider

  Store-billing rules also affect every in-app payment. All of these are listed in **§2a**.
- **Five phases.** Phase 1 needs no outside service, so it can start as soon as you approve this plan.

Size legend, for one developer across backend, website and app. It excludes device QA and the time vendors take to onboard you.

| Size | Rough time |
|---|---|
| **S** | up to 1 day |
| **M** | 2–4 days |
| **L** | 1–2 weeks |
| **XL** | 3+ weeks |

---

## 2. What I need from you

### 2a. Third-party APIs and services

| Needed for | What | My recommendation | Alternatives | Cost type | What I need from you |
|---|---|---|---|---|---|
| #30, #74, #79, #80 | Automatic GST, PAN and Aadhaar (OTP / DigiLocker) verification | **Cashfree Verification Suite**. You already have a Cashfree merchant account, so it's the same dashboard and the same billing. | Surepass, Signzy, IDfy, HyperVerge, Digio | Pay per check | Enable the product; sandbox and live keys |
| #7 | GIFs and stickers in chat | **GIPHY API**, which covers GIFs and stickers in one API | KLIPY, Tenor | Free, with a "Powered by GIPHY" credit. The production key needs GIPHY's approval. | API key |
| #29, #34, #66 | Music on posts, vibes and stories | **Start with "original audio"**: the sound from users' own uploads, reusable through "use this audio". Add a **royalty-free catalogue** on top. Licensed film or pop songs need a licensing deal. | Royalty-free or licensing APIs: Epidemic Sound, Soundstripe, Mubert (AI-generated music), Jamendo. Bollywood and film songs: licences from the labels (T-Series, Saregama, Sony Music India, Zee Music). | Licence or subscription | Decide your budget and whether film songs are a must. **Spotify and Apple Music cannot be used**: their terms forbid putting songs into user videos. |
| #3 (video), #34, #49, #62, #66, #71, #72 | Video editing: trim, merge, transitions, text and sticker overlays, mixing in music, split-screen duet | **Option A (no licence fee):** open-source FFmpeg (a maintained community fork; the original ffmpeg-kit was retired in 2025) plus an editor UI I build. More development time, and a bigger app. **Option B (paid):** IMG.LY CreativeEditor SDK or Banuba Video Editor SDK. A ready-made TikTok-style editor, delivered much faster. | — | A: free, but adds tens of MB to the app. B: yearly licence. | **Choose A or B** |
| #62, #66 (the "effects" part) | AR face filters and effects | Only needed if you want face filters: **Banuba** or **DeepAR**. Simple colour filters need no SDK. | Snap Camera Kit | Licence | Do you need AR face effects? |
| #35 | One-tap background removal, lighting fix, sharpening | **Photoroom API**, which is built for product photos | remove.bg, Clipdrop, Cloudinary AI. Free on-device background removal (Google ML Kit / Apple Vision) at lower quality. | Per image | API key, plus a monthly cap per plan |
| #45 (optionally #11) | "AI" hashtag suggestions | A free version built from your own data: trending tags plus tags used together in the same category. Optionally add the **Claude API** (claude-haiku-5-5) reading the caption and photo for better tags. | OpenAI, Gemini | Small cost per request | Do you want the AI step? If yes, an API key |
| #73 | Voice-to-text captions | The phone's and browser's built-in speech recognition. Free; Firefox doesn't support it. | Google Cloud Speech, Whisper | Free | Nothing |
| #4, #10 | Email for every notification | Your current Zoho SMTP is fine for OTPs but has daily sending limits. For "all notifications", use **Zoho ZeptoMail** (same vendor) or **Amazon SES**. | SendGrid, Brevo, Resend | Per email (cheap) | Account, plus SPF/DKIM DNS records on findernate.com |
| #42 | City of website visitors who don't share their location | **MaxMind GeoLite2**, a free database that maps IP address to city | ipinfo | Free | Free MaxMind account |
| #2, #40 (calls) | End-to-end encrypted calls | Calls are encrypted in transit, but they pass through Stream.io's servers and are not end-to-end encrypted by default. True E2EE calls depend on Stream supporting it in both its React and Flutter SDKs. | — | — | Ask Stream support. I can draft the question for you. |
| #1 | SEO | Google Search Console | — | Free | Verify findernate.com in Search Console |
| #27, #74, #77, #80 | Taking payments inside the Android and iOS apps | Ads, the ₹100 re-KYC fee, listing fees and a consumer plan are digital purchases. Google Play (and Apple) generally require their own billing for these, which is why your subscriptions already moved to Play Billing. Google's "User Choice Billing" in India is an option. The website can keep using Cashfree. | — | Store commission | Decide, then create the products in Play Console and App Store Connect |

### 2b. Questions

Each question is tagged with the phase it blocks. Where you don't answer, I'll use the default given.

| # | Blocks | Question | My default |
|---|---|---|---|
| Q1 | Phase 1 (#19) | Which screens get the 3-column preview grid: profile and explore only, or also the home feed and search? Website mobile view only, or the app as well? | Profile, explore and search grids, on both the website's mobile view and the app |
| Q2 | Phase 1 (#23) | Do you have a design (Figma or screenshot) for the new normal-post card? | Follow the business-card layout so all cards look consistent |
| Q3 | Phase 1 (#28) | The gesture set (see #28 below). Anything to add? | As listed |
| Q4 | Phase 2 (#3) | 1.91:1 at 1080 wide is **1080×566**, but the PDF says **1080×608** (which is 16:9). Which one? Do vibes (reels) stay full-screen 9:16? | 1080×566; vibes stay 9:16 |
| Q5 | Phase 2 (#15) | What goes into the Bin? | Posts, vibes, notes and stories. Chat messages keep their own "delete for me / for everyone". |
| Q6 | Phase 2 (#32) | Who sees story comments: only the story owner, or everyone who views the story? | Owner only |
| Q7 | Phase 2 (#26) | The final list of content categories (Comedy, Technology, Sports, Music…)? | A list of about 20 common categories, which you can then edit |
| Q8 | Phase 3 (#2) | E2EE means your admins can no longer read chats, server-side message search stops working, and a new device can't see old messages unless the user sets a backup PIN. Is that acceptable? | Yes, 1:1 chats first |
| Q9 | Phase 3 (#25) | Maximum accounts per device? | 5 (same as Instagram) |
| Q10 | Phase 4 (#74) | Businesses your admins have already approved: treat them as KYC-verified, or make them verify again? If they must re-verify, their business posts are hidden until they do. | Treat as verified, and prompt them to complete the automatic check within 30 days |
| Q11 | Phase 4 (#74) | Which payments count as B2B: both buyer and seller are verified businesses? Normal orders stay at today's 2.5% platform fee? | Yes to both |
| Q12 | Phase 4 (#77) | Regular users have no subscription plan today; plans are Free, Small Business and Corporate. Is there a new consumer plan? At what price? Does it include calling? | Need your answer |
| Q13 | Phase 4 (#78) | Which plan is "Premium": Corporate, or a new tier? | Corporate |
| Q14 | Phase 4 (#27) | Is ₹100/day inclusive of GST? Any targeting (city or category), or always all users? Do the boosts included in plans stay alongside paid ads? | Excludes GST; all users; plan boosts stay |
| Q15 | Phase 4 (#80) | What is the listing fee for 30 days and for 60 days? Is listing validation done by your admins or by automatic checks only? | Automatic checks, plus an admin queue for flagged listings |
| Q16 | Phase 4 (#75) | Notify verified businesses on every view, or send a digest such as "12 people viewed your profile today"? | Instant for the first few each day, then a daily digest |
| Q17 | — | #39 and #43 are blacked out. Intentionally removed? | Skipped |

---

## 3. Roadmap

| Phase | Theme | Items | Needs from you before it starts |
|---|---|---|---|
| **1** | Quick wins and UX polish | 5, 6, 8, 9, 12, 13, 16, 18, 19, 20, 22, 23, 24, 28/51/52, 31, 38, 41, 44, 59, 61, 63, 73 | Nothing (Q1–Q3 are nice to have) |
| **2** | Engagement and discovery | 3, 10, 11, 14, 15, 17, 26, 32, 33, 36, 42, 45, 46, 50/57, 53, 54, 55, 56, 58, 64, 65, 68, 70, 71, 72 | Q4–Q7; email provider (#10) |
| **3** | Chat and privacy | 21, 37, 48, 7, 25, 2/40 | GIPHY key; Q8, Q9; Stream's answer on calls |
| **4** | Business trust, money and SEO | 79, 30, 4, 74, 75/76, 78, 77, 27, 80, 1 | KYC API keys; store-billing decision; Q10–Q16 |
| **5** | Creator tools | 29, 34/62, 66, 49, 47, 35 | Video-toolkit choice (A or B); music decision; image-API key |

**Why this order:**

- Phase 1 ships visible improvements immediately with no dependencies.
- Phases 2–3 are self-contained product work.
- Phase 4 waits on vendor accounts and billing decisions, which take time to arrange, so asking now means they're ready when we get there.
- Phase 5 depends on the most expensive decisions (video toolkit and music), so it comes last.

Each phase ships as one pull request per repo. The order within a phase is backend first, then website, then app.

---

## 4. Feature details

Abbreviations in the **Work** column: **BE** = backend, **Web** = website, **App** = Flutter app.

### Phase 1: Quick wins and UX polish

| # | Feature | Today | Work | Size |
|---|---|---|---|---|
| 5 | "Follow suggestions" on home, between posts and reels | Partial. The `/suggested-for-you` API exists, but the website shows it only in the desktop right sidebar, and the app home doesn't show it. | **Web + App:** horizontal "Suggested for you" row inside the home feed, with Follow and dismiss buttons | S |
| 6 | Share posts and reels without signing in | Partial. Public `/r/[postId]` pages and a public share API exist. | **Web:** share button on the guest post view. **App:** share sheet works in guest mode. Check that links open without login. | S |
| 8 | WhatsApp-style attachment sheet | App done (Camera / Gallery / Document). The website has a plain attach button. | **Web:** attachment menu with Camera, Gallery and Files | S |
| 9 | Voice notes: record, **preview**, send | Website done, including preview. The app sends immediately after you stop recording. | **App:** preview bar after stopping (play/pause, duration, delete, send) | S |
| 12 | Hide mobile number and location on profile | Partial. The `isPhoneNumberHidden` / `isAddressHidden` flags exist and the app has toggles. The website has no toggles, and business contact details aren't covered. | **BE:** enforce the flags in every profile and business response. **Web:** toggles in privacy settings. **App:** extend the toggles to business profiles. | S |
| 13 | Move profile editing into Settings; separate Business Settings | Partial. The app has a Business Settings screen; profile editing is spread across screens. | **Web + App:** Settings → Account (profile, phone, email, date of birth). Settings → Business Settings (details, documents/KYC, bank, plan, social links). | M |
| 16 | Calling: only paid users can call; they can call anyone | Mostly done. The backend already stops free users from starting calls, and free users can still answer. | **BE:** remove the stale `User.hasCallingAccess()`, which wrongly allows business accounts with no plan. **Web + App:** check the upgrade prompt shown on `CALLING_FEATURE_RESTRICTED`. | S |
| 18 | Turn off likes, comments or sharing on a post | Partial. The settings fields exist on posts, but the backend never enforces them and the website has no controls. | **BE:** enforce the settings in like, comment and share. **Web + App:** toggles in the composer and the post "…" menu; hide the buttons when turned off. | M |
| 19 | 3-column mobile grid with previews and a "View details" icon | New | **Web (mobile widths) + App:** 3-column preview grid; the icon opens the full post (Q1) | S–M |
| 20 | Social media links on business profiles, with a show/hide setting | Partial. The links are stored (`Business.contact.socialMedia`) but never shown. | **BE:** visibility setting. **Web + App:** icons on the business profile, and a toggle in Business Settings. | S |
| 22 | Date of birth: pick from a calendar or type it | Partial: calendar picker only | **Web + App:** DD/MM/YYYY text field with a calendar button; same age validation either way | S |
| 23 | Redesign the normal-post card (too much white space) | New | **Web + App:** tighter card: media, caption, actions, no empty detail block (Q2) | M |
| 24 | Share posts and vibes inside the app and to other apps | Partial. External sharing exists; there's no "send to chat". | **BE:** new "shared post" chat message type carrying a snapshot of the post (same pattern as existing story replies). **Web + App:** "Send to" sheet listing recent chats with search, plus the external share. | M |
| 28, 51, 52 | Gestures: double-tap to like, hold to pause, tap forward/back | Partial. Only app posts have double-tap like. | **Web + App:** double-tap heart burst on posts and vibes; hold to pause / release to play on vibes and stories; tap right/left for next/previous story; swipe for next/previous vibe; long-press a post for a quick menu (Q3) | M |
| 31 | Story music doesn't play | Bug | Investigate and fix. **App:** story video items are set up with a fixed 5-second duration and default audio settings. **Web:** videos autoplay muted with no unmute button. Also check the upload path. | S–M |
| 38 | Mute notifications per chat | Partial. A `Chat.mutedBy` field exists, but there's no API and pushes still go out. | **BE:** mute/unmute API (8 hours, 1 week, always); skip the push for muted chats. **Web + App:** mute option, and a mute icon in the chat list. | S |
| 41 | Preload the first 3–4 vibes | New | **App:** start loading the first 4 videos as soon as the list arrives, and keep the next 2–3 ready while scrolling. **Web:** same with the next videos. | M |
| 44 | Link previews showing product title, price and thumbnail | Partial. Website link previews exist for `/r/[id]`. | **Web:** add the price, plus a generated preview image with a price tag. **App:** share text in the form "Title · ₹Price + link". | S |
| 59 | More / Less on descriptions (posts, vibes, notes) | Partial: some website screens | **Web + App:** one shared expandable-text component used everywhere | S |
| 61 | Vibes playback speed 0.5x / 1x / 2x | New | **Web + App:** speed menu on vibes | S |
| 63 | Video quality adjusts to internet speed | Partial. Bunny already encodes several qualities, but the app picks one fixed MP4 based on connection type. | **Web + App:** play Bunny's adaptive HLS stream, which switches quality automatically; MP4 as a fallback | M |
| 73 | Speak a caption instead of typing it | Partial. The app already uses speech-to-text for search. | **App:** mic button on caption fields. **Web:** browser speech recognition where supported. | S |

### Phase 2: Engagement and discovery

| # | Feature | Today | Work | Size |
|---|---|---|---|---|
| 3 | Smart crop to 4:5, 1:1 or 1.91:1 | New | **Web + App:** detect the ratio, choose the nearest supported one (rules in §5.6), then a zoom/move/crop editor locked to that ratio. Photos are cropped on the device. For videos, the crop area is sent with the upload and a server FFmpeg job applies it before the video goes to Bunny. **BE:** rejects media that doesn't match a supported ratio. | L |
| 10 | Email notifications for every case | Partial. Zoho SMTP already sends OTPs and some emails. | **BE:** one notification dispatcher sending in-app, push and email per event type; email templates; per-category email settings with unsubscribe; daily digest for likes and comments so nobody gets spammed | M |
| 11 | Suggestions while writing a post | Partial: location autocomplete exists | **BE:** suggestion API for hashtags, @users, categories and subcategories, using the existing search engine. **Web + App:** suggestions appear while typing. | M |
| 14 | Watch history for posts and vibes, with delete | Partial. Views are already tracked and a history endpoint exists; there's no screen. | **BE:** history by type, delete one or all, pause history. **Web + App:** Settings → Your activity → History. | M |
| 15 | Bin: restore within 15 days, then permanent deletion | New. Deleting is permanent today. | **BE:** deleted items move to a Bin (design in §5.2), can be restored within 15 days, and a daily job permanently deletes them, including media files. **Web + App:** Bin screen with "Restore" and "Delete now". | L |
| 17 | Up to 10 subcategories per post, linked to search | Partial: one subcategory per post | **BE:** up to 10 subcategories per post, added to the search index with filters; product-style result cards. **Web + App:** chip input with suggestions. | M |
| 26 | Category preferences at signup and in Settings | New | **BE:** store preferred categories; feed and vibes ranking favour them. **Web + App:** category picker at signup, editable in Settings. | M |
| 32 | Like and comment on stories | New. Replying today sends a DM. | **BE:** story likes and comments, with notifications. **Web + App:** heart and comment box in the story viewer; the owner sees likes and comments in the viewers list (Q6). | M |
| 33 | Seen / not seen on listings | New | **BE:** listing responses carry a "seen" flag from view tracking; "fresh" means unseen and recent. **Web + App:** dim seen items, highlight fresh ones. | M |
| 36 | Nested comments with like/unlike | Mostly done in the API, website and app | Polish: collapse and expand reply threads; like buttons on replies everywhere | S |
| 42 | "Trending near you" and hot deals at the top of the feed | New | **BE:** a job every 3 hours ranks items per city by recent engagement. Products need an "original price" field so discounts can be detected. City comes from device location, the profile, or the IP address. **Web + App:** carousel at the top of home. | L |
| 45 | Hashtag suggestions | New | **BE:** suggestions from trending tags and tags used together in the same category (free); optional AI step (§2a). **Web + App:** suggestion chips in the composer. | M |
| 46 | View milestones at 50 / 100 / 500 | New | **BE:** when a listing crosses each threshold, notify the seller: "Your listing is gaining attention — consider boosting it", with a boost link | S |
| 50, 57 | Collab posts (video and photo) | New | **BE:** invite a collaborator, who accepts or declines. On accept, the post appears on both profiles and in both sets of followers' feeds, with shared likes and comments; either person can remove themselves. **Web + App:** invite in the composer, accept/decline screen, "A and B" in the post header. | L |
| 53 | Creator pins one comment | New for comments (already exists for chat messages) | **BE:** one pinned comment per post, set by the post owner. **Web + App:** pin/unpin, shown at the top as "Pinned by creator". | S |
| 54 | Save to private named collections | Partial: saving exists, without folders | **BE:** create and manage collections, save into one; saves already count towards ranking. **Web + App:** "Save to…" sheet, and collections on the Saved page. | M |
| 55 | Glowing "new post" ring on followed creators | New | **BE:** list followed creators with new posts the viewer hasn't seen. **Web + App:** a ring in the top bar, distinct from the story ring. | M |
| 56 | Repost a post or vibe to your story | New | **BE:** a story that references the original post and credits its creator; the creator is notified. **Web + App:** "Add to story" in the share sheet; the post card shows inside the story, and tapping it opens the original. | M |
| 58 | Trending topics bar (top 10, refreshed every 30 minutes) | New | **BE:** a 30-minute job computes the top hashtags and caches them. **Web + App:** bar on home and explore; tapping a topic shows its posts. | M |
| 64 | @mentions in posts and comments | Partial: posts have a mentions field | **BE:** parse @usernames in captions and comments, notify the mentioned user, and add a "who can mention me" setting. **Web + App:** autocomplete while typing; tappable mentions. | M |
| 65 | Profile visitors (optional) | New | **BE:** profile-view log and a privacy toggle; if you hide your own visits, you can't see your visitors either. **Web + App:** "Profile visitors" screen. | M |
| 68 | "Not interested" | Partial. A hide endpoint exists, but the feed ignores it. | **BE:** remove the post and show less from the same author, category and hashtags. **Web + App:** "Not interested" menu item with Undo. | M |
| 70 | Drafts for vibes, posts and notes | Partial. A Draft model exists with no API; the app keeps only one local draft. | **BE:** drafts API. **Web + App:** "Save draft", a drafts list, and resume editing. | M |
| 71 | Choose a vibe's cover image | New | **BE:** accept a custom cover. **Web + App:** pick a frame from the video or upload an image. | M |
| 72 | Full-screen vibe preview before posting | New | **Web + App:** preview step, with music, text and filters applied | S |

### Phase 3: Chat and privacy

| # | Feature | Today | Work | Size |
|---|---|---|---|---|
| 21 | Group roles: Owner, Admin, Member | Partial. Groups have an admin list and member removal, but any admin can remove other admins or delete the whole group. There is no way to add members or promote admins. | **BE:** the permissions in §5.3: add members, promote/demote admins, block, owner-only delete, system messages ("X made Y an admin"). **Web + App:** member list with role badges and actions. | L |
| 37 | Disappearing messages | New | **BE:** per-chat timer (off / 24 hours / 7 days / 90 days); a job deletes expired messages and their media. **Web + App:** the setting, plus a timer icon. | M |
| 48 | View-once photos and videos in DMs | New | **BE:** view-once flag; media deleted after the first open. **App:** opens once, can't be forwarded or saved, screenshots blocked on Android. **Web:** opens once, no download. | M |
| 7 | GIFs and stickers in chat | New | **BE:** GIF search goes through our server, which keeps the API key private and caches results. **Web + App:** GIF/sticker picker and new message types. | M (API) |
| 25 | Several accounts on one device ("Add account") | New | **BE:** a register of devices per account. Today each user has a single push token, so even two phones on one account don't both get notifications. Notifications are tagged with the target account. **Web + App:** "Add account", account switcher, notifications for every signed-in account. | L |
| 2, 40 | End-to-end encryption, with an indicator | New | See §5.4 | XL |

### Phase 4: Business trust, money and SEO

| # | Feature | Today | Work | Size |
|---|---|---|---|---|
| 79 | Registered vs Unregistered business at signup | Partial. Documents can be uploaded and admins review them by hand. | **BE:** registration type. Registered = GSTIN + business PAN; Unregistered = Aadhaar + PAN. Separate badges for each. **Web + App:** a step in business onboarding. | L |
| 30 | GST and PAN auto-verification | New. Today an admin checks documents manually. | **BE:** verification API (§2a); name matching between GST, PAN and the business name; anything that doesn't match goes to the admin queue | M (API) |
| 4 | Email confirmation of business details, then locked | New | **BE:** email listing the mandatory fields with Confirm / Reject links; confirmed details are locked. **Web + App:** "This information can no longer be edited" message. Later changes go through re-KYC (#74). | M |
| 74 | KYC-based post visibility, subscription visibility, re-KYC fee, B2B payments | Partial. Admin verification exists, search already hides unpaid sellers, and plan-expiry reminders exist. | **BE:** visibility rules in §5.1; verified badge, and the notification text from the PDF; ₹100 re-KYC payment; optional B2B checkout through your gateway with 10% commission, plus statements for both businesses and the platform. **Web + App:** KYC status, badges, payment flows, and a "pay outside at your own risk" notice. | XL |
| 75, 76 | Warning when chatting with unverified users; view notifications for verified businesses | New | **BE:** separate tracking of profile views and business-post views; notifications that respect privacy settings (Q16). **Web + App:** warning banner in chat; view counts in Insights. | M |
| 78 | Premium business posts always on top | Partial: plan-based boost weighting exists | **BE:** Premium business posts take the top positions wherever business posts appear, for all users; automatic return to normal ranking when the plan expires | M |
| 77 | Regular-user subscription: no ads, expiry shown, reminders | Partial: subscriptions and reminders exist | **BE:** subscribers are excluded from ad serving. **Web + App:** "Expires in 15 days" / "Valid until 22 Sep 2026" on the profile and subscription screens (Q12). | M |
| 27 | Boosted ads (₹100/day) | Partial. Boosts included with plans exist; there are no paid ads. | **BE:** ad campaigns of three types (WhatsApp/contact, app promotion, website), cost = daily fee × days, payment, scheduling, automatic stop, serving with a "Sponsored" label and action button, statistics (§5.5). **Web + App:** create-ad flow and an ads dashboard. | XL |
| 80 | One-time product post for regular users | New | **BE:** Aadhaar check → listing validation → pay the one-time fee → visible to everyone for 30 or 60 days → expires automatically; renewal = pay and validate again. **Web + App:** the flow screens (Q15). | L |
| 1 | Business posts appear in Google search | Partial. Link-preview tags exist, but pages render only in the browser, and there's no sitemap, robots.txt or structured data. | **Web:** server-rendered pages for business, product and service posts and for business profiles; readable URLs; Google "Product" and "LocalBusiness" structured data; sitemap.xml; robots.txt; canonical tags. **BE:** sitemap data feed. Only KYC-visible posts are indexed. | L |

### Phase 5: Creator tools

| # | Feature | Today | Work | Size |
|---|---|---|---|---|
| 29 | Music on posts | New | **BE:** music library plus "original audio" taken from uploads. For vibes, the audio is mixed into the final video on the server; photo posts get a background track. **Web + App:** music picker with clip selection. | L, plus licensing |
| 34, 62 | Reel editor: trim, merge, transitions, effects, stickers, price tags, text, music | New | **App:** editor screens on the chosen toolkit (§2a). **Web:** a lighter version (trim, cover, text, music). | XL |
| 66 | One-tap reel camera | New | **App:** quick camera: record, add music, add effects, post | L |
| 49 | Duet and reaction videos | New | **App:** record side by side with the original; the two are combined into one split-screen video that credits the original | L |
| 47 | Interactive story stickers: poll, quiz, emoji slider, countdown, "Ask me anything" | New | **BE:** sticker data and responses. **App:** a sticker layer on top of the current story designer. **Web:** the same in the story creator. The owner sees results. | L |
| 35 | AI photo enhancer | New | **BE:** goes through our server to the image API, with a monthly limit per plan. **Web + App:** "Enhance" button with a before/after comparison. | M (API) |

---

## 5. Key designs

### 5.1 Business post visibility (#74, #78, #79)

| Business status | Who sees its product, service and business posts |
|---|---|
| KYC not done, pending or rejected | Nobody except the business itself |
| KYC verified, no active plan | The business's followers and following |
| KYC verified, active plan | Everyone (home, explore, search, vibes) |
| KYC verified, Premium plan | Everyone, ranked at the top |

- **Normal posts** from business accounts follow the normal rules.
- This replaces today's "hide unpaid sellers from search" rule.
- The computed status is saved on the account and in the search index, so search can filter by it directly. The existing search code already notes this as the next step. It's recalculated whenever KYC changes, a plan starts, or a plan expires.
- **Grandfathering** of already-approved businesses: see Q10.

### 5.2 Bin (#15)

- **How deletion works:** a deleted item moves into a separate "Bin" collection instead of being erased. It disappears from every feed, profile and search immediately, and none of the existing read code has to change.
- **Kept until the 15-day purge:** media files, likes, comments and saves. That way a restore brings everything back.
- **Links:** while an item is in the Bin, links to it keep showing the existing "deleted" notice. Restoring removes the notice.
- **Purge job:** runs daily. It deletes the media from Bunny and all related records, and cancels any boost or ad on the item.
- **Not recoverable:** items deleted before this feature ships are already gone.

### 5.3 Group chat permissions (#21)

| Action | Owner | Admin | Member |
|---|---|---|---|
| Add members | ✔ | ✔ | ✖ |
| Remove or block members | ✔ | ✔ | ✖ |
| Remove or block admins | ✔ | ✖ | ✖ |
| Make or remove admins | ✔ | ✖ | ✖ |
| Remove or block the owner | ✖ | ✖ | ✖ |
| Delete the group | ✔ | ✖ | ✖ |

If the owner leaves the group, ownership passes to the longest-serving admin, or to the longest-serving member if there are no admins.

### 5.4 End-to-end encryption (#2, #40)

**How it works:**

- Every phone or browser gets its own key pair.
- Messages and attachments are encrypted on the sender's device using well-tested libraries: libsodium on the website, and the crypto library the app already includes.
- The server stores only scrambled data it cannot read.
- Group chats use "sender keys" so a message is encrypted once per group, not once per member.
- A lock badge and the line "Messages are end-to-end encrypted" act as the indicator. An optional safety-code screen lets two users confirm they're talking to each other.

**What changes:**

- Your admins can no longer read chats. Reports can still include the messages the reporter chooses to attach.
- Server-side message search stops working.
- Push notifications show "New message" unless the phone decrypts the message first.
- A new device can't see old messages unless the user sets a backup PIN.
- Payment, order and checkout messages stay as server messages and are labelled as such.

**Calls** are encrypted in transit, but they pass through Stream.io's servers. They are only end-to-end encrypted if Stream supports it in both SDKs.

**Recommendation:** start with 1:1 chats, then add groups. Don't show the lock badge on calls until Stream's support is confirmed.

### 5.5 Paid ads (#27, #77, #46)

- **Lifecycle:** draft → waiting for payment → scheduled → running → completed. An ad can also be cancelled, or rejected if you want an admin review step.
- **Price:** daily fee × number of days. The ₹100 fee lives in admin settings, so it can change without an app release.
- **Serving:**
  - One sponsored item every N posts or vibes.
  - A cap on how often one user sees the same ad.
  - Never shown to subscribers (#77).
  - Fair rotation between all running ads.
  - Stops automatically at the end date.
- **Advertiser dashboard:** start date, expiry date, duration, payment status, campaign status, impressions and clicks.
- The "consider boosting" milestone notifications (#46) link straight into this flow.

### 5.6 Smart crop rules (#3)

The ratio r = width ÷ height picks the format. The boundaries are the midpoints between neighbouring formats.

| Ratio of the uploaded media | Format chosen | Output size |
|---|---|---|
| r < 0.894 | 4:5 | 1080×1350 |
| 0.894 ≤ r ≤ 1.382 | 1:1 | 1080×1080 |
| r > 1.382 | 1.91:1 | 1080×566 (see Q4) |

- **Carousels:** every item uses the first item's format, as Instagram does.
- **Editing:** the user can zoom and move freely inside the frame. The media is never stretched; any area outside the frame is cropped away.

---

## 6. Risks and compliance

1. **Aadhaar storage.** `Business.aadhaarNumber` stores full Aadhaar numbers in plain text. UIDAI rules restrict storing full Aadhaar numbers. Once a verification provider is in place, we should keep only the last 4 digits plus the provider's reference ID, and migrate the existing records. Planned for Phase 4.
2. **Store billing.** In-app digital purchases (ads, fees, a consumer plan) likely need Play Billing and Apple in-app purchase. This affects pricing because the stores take a commission.
3. **Music copyright.** Using film or pop songs without a licence carries legal risk. Until a licence is in place, offer only original audio and royalty-free music.
4. **E2EE trade-offs.** Moderation, message search and message history change, as listed in §5.4.
5. **Server load.** Video cropping, music mixing and duets add FFmpeg work on the server. It runs as background jobs (BullMQ is already in place), but a separate worker machine may be needed as usage grows.
6. **App size.** The FFmpeg or AR libraries add tens of MB to the app download.
7. **Visible change for businesses.** The new visibility rules hide posts from businesses that aren't verified yet. Decide grandfathering (Q10) and tell businesses before release.
8. **Tax.** GST on ad fees, listing fees, the re-KYC fee and commission should be checked with your accountant. The invoicing code that already exists can include them.
9. **Older app versions.** Older versions stay in use after each release, so new API fields are optional and no endpoint is removed.
10. **Mismatches in the PDF.**
    - The 1.91:1 pixel size (Q4).
    - #76 duplicates #75.
    - #39 and #43 are blacked out.
    - #60, #67 and #69 are missing.

---

## 7. How I'll build, test and ship

- **Order per feature:** backend API (plus any data migration), then the website, then the app.
- **Pull requests:** one per repo per phase, on branch `claude/brave-mendel-9p769d`. Each app release gets a version bump.
- **Prices and limits in admin settings:** ₹100/day ads, ₹100 re-KYC, listing fees, 10% B2B commission, the 15-day Bin, and the milestone thresholds are stored in the existing settings collection. They can change without a release.
- **Backend testing:** there are no automated tests today. I'll add tests for the rule-heavy parts (visibility rules, group permissions, Bin purge, ad billing, KYC states) running against an in-memory database.
- **Website testing:** lint plus a full production build.
- **App testing:** Flutter isn't installed in my environment. I'll install the version the app needs (3.38) and run the analyzer and unit tests.
- **What I can't test:** I can't run the app on a real phone. Payments, KYC, GIFs and music need sandbox keys. Your team does device QA each phase, and every PR includes a QA checklist.
