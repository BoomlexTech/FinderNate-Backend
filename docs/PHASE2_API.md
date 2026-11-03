# Phase 2 API (part 2: engagement and discovery)

Base URL: `/api/v1`. All responses use the usual `{ statusCode, data, message }` envelope. "Auth" means a signed-in user (Bearer token). Every new field is optional, so older app versions keep working.

## Posts

| # | Method and path | Body / query | Notes |
|---|---|---|---|
| 64 | `POST /posts/create/*`, `PUT /posts/edit/:postId`, `POST /posts/comment`, `PUT /posts/comment/:id` | – | `@username` in captions, descriptions and comments becomes a mention if that account allows it (see `mentionPrivacy`). Mentioned accounts get a `mention` notification. Comments come back with `mentions: [{ _id, username }]`. |
| 17 | `POST /posts/create/*`, `PUT /posts/edit/:postId` | `subcategories`: array, JSON array or comma list | Up to 10, each up to 40 characters, de-duplicated. Search: `GET /users/search/products?subcategory=` matches any of them. |
| 3 | `POST /posts/create/*` | `mediaLayout`: `{ aspect: '4:5' \| '1:1' \| '1.91:1', items: [{ crop: { x, y, width, height } }] }` | Photos are cropped on the device. Videos are uploaded whole and the `crop` window (0..1 fractions) is stored on `media[i].crop`. Players show it with object-fit: cover. `media[i].aspect` is always set (vibes: `9:16`). |
| 50 | `POST /posts/create/*` | `collaborators`: array of user ids (max 3) | Sends `collab_invite`. The owner's account must be public. |
| 70 | `POST /posts/create/*` | `draftId`, with no files | Publishes a draft using its already-uploaded media. The draft is then removed. |
| 71 | `POST /posts/create/*` (multipart `thumbnail`) and `PATCH /posts/:postId/cover` (multipart `thumbnail`) | image file | The vibe's cover. Pick a frame on the device and send it as an image. |
| 53 | `PATCH /posts/:postId/pinned-comment` | `{ commentId }` | Creator only; top-level comments only. `DELETE` unpins. `GET /posts/comments` page 1 then starts with the pinned comment (`isPinned: true`) and returns `pinnedCommentId`. |
| 68 | `POST /posts/:postId/not-interested` | – | Hides the post from that viewer's home and vibes, and ranks its author, category and repeated hashtags lower. `DELETE` is the Undo. |
| 54 | `GET /posts/collections` | – | `{ allSaved: { count, covers }, collections: [{ _id, name, count, covers }] }` |
| 54 | `POST /posts/collections` | `{ name, postId? }` | 1–50 characters, unique per user (409), max 100. |
| 54 | `PATCH` / `DELETE /posts/collections/:id` | `{ name }` | Deleting keeps the posts saved. |
| 54 | `POST /posts/collections/:id/posts` | `{ postId }` | Saves the post if needed. `DELETE /posts/collections/:id/posts/:postId` removes it from the collection only. |
| 54 | `POST /posts/save` | `{ postId, collectionId? }` | `GET /posts/saved?collectionId=` lists one collection. `GET /posts/saved/check/:postId` also returns `collectionIds`. |
| 50 | `POST /posts/:postId/collaborators` | `{ userId }` | Owner invites. |
| 50 | `DELETE /posts/:postId/collaborators/:userId` | – | Owner removes anyone; a collaborator removes themselves. |
| 50 | `POST /posts/:postId/collab/accept`, `/collab/decline` | – | Invitee answers. Accepted collabs appear on both profiles. |
| 50 | `GET /posts/collab/invites` | – | Pending invites for the caller. |
| 15 | `DELETE /posts/:postId` | – | Now moves the post or story to the Bin: `{ inBin: true, binId, purgeAfter }`. |

Post payloads (home feed, profile grids, post detail) now carry:
- `collaborators: [{ _id, username, fullName, profileImageUrl }]`: accepted only. The owner also gets `pendingCollaborators`.
- `isSeen`, `isFresh` (#33): `isFresh` means not seen and posted in the last 48 hours. Also on explore and product search results.
- `subcategories`, `category`, `hashtags`, `pinnedCommentId`.
- `engagement.views` now counts unique viewers (never the author).

## Stories (#32, #56)

| Method and path | Body | Notes |
|---|---|---|
| `POST /stories/:storyId/like`, `DELETE …/like` | – | Returns `{ isLiked, likesCount }`. Only while the story is live (410 afterwards). |
| `GET /stories/:storyId/likes` | – | Owner only, also on archived stories. |
| `POST /stories/:storyId/comments` | `{ content }` (≤ 500) | The owner gets `story_comment`. |
| `GET /stories/:storyId/comments` | – | The owner sees all comments, including on archived stories; anyone else sees only their own. |
| `DELETE /stories/:storyId/comments/:commentId` | – | Owner or author. |
| `POST /stories/repost` | `{ postId, caption? }` | Shares a post or vibe to your story as a card (`sharedPost`) that credits the creator. The creator gets `repost`. Respects the author's sharing switch. |

Story payloads now carry `likesCount` and `isLiked`; the owner also gets `commentsCount`. `GET /stories/:id/viewers` adds `liked` per viewer, plus `likesCount` and `commentsCount`.

**Expiry:** a story that people liked or commented on is moved to its owner's archive when its 24 hours end (`autoArchivedAt` set), keeping its likes, comments and viewers. Other stories are deleted as before. `GET /stories/archived/:userId` gives the owner `likesCount`, `commentsCount` and `viewerCount`.

## Signed-in user

| # | Method and path | Notes |
|---|---|---|
| 14 | `GET /users/me/history?type=posts\|vibes&page&limit` | `{ items: [{ postId, viewedAt, post }], paused, pagination: { hasMore } }` |
| 14 | `DELETE /users/me/history/:postId`, `DELETE /users/me/history?type=` | Removes one entry, or all entries (optionally only posts or only vibes). |
| 14 | `PATCH /users/me/history/settings` | `{ paused }`. While paused, nothing is recorded. |
| 26 | `GET /users/me/categories`, `PUT /users/me/categories` | `{ categories: [...] }`, max 10, names from `GET /meta/categories`. |
| – | `GET` / `PATCH /users/me/activity-settings` | `{ mentionPrivacy: everyone\|following\|nobody, historyPaused, profileVisitsHidden, emailNotifications: { activity, messages: digest\|off }, preferredCategories }` |
| 65 | `GET /users/me/profile-visitors` | `{ visitors: [{ user, lastVisitedAt, visitCount }], hidden }`. Hiding your visits also hides your visitors. |
| 55 | `GET /users/me/new-post-ring` | `{ creators: [{ user, latestAt, unseenCount, latestPostId }] }`: people you follow with unseen posts from the last 3 days. |

## Discovery

| # | Method and path | Notes |
|---|---|---|
| 26 | `GET /meta/categories` | Public. Admins can change the list with the `CONTENT_CATEGORIES` setting. |
| 11 | `GET /suggestions/compose?type=hashtag\|mention\|category\|subcategory&q=&category=` | Hashtags: `[{ tag, count }]`. Mentions: `[{ _id, username, fullName, profileImageUrl, isFollowing }]`. Categories: `[name]`. Subcategories: `[{ label, count }]`. |
| 45 | `POST /suggestions/hashtags` | `{ caption, category }` → `{ suggestions: [{ tag, reason: related\|caption\|category\|trending }] }` |
| 58 | `GET /explore/trending-topics` | `{ topics: [{ tag, postCount }], updatedAt }`. Refreshed every 30 minutes. |
| 58 | `GET /explore/hashtag/:tag?page` | Newest public posts with that tag. |
| 42 | `GET /explore/trending-near-you?city=` | `{ scope: city\|nationwide, city, cityLabel, trending: [post], deals: [post] }`. The city comes from `?city=`, else the profile location. Deals have `discountPercent`; products take a new optional `originalPrice`. |

## Drafts (#70) and Bin (#15)

| Method and path | Notes |
|---|---|
| `GET /drafts?postType=`, `POST /drafts`, `GET` / `PUT` / `DELETE /drafts/:id` | Body: `{ postType, contentType, title, payload (composer state, ≤ 64 KB), media: [{ url, thumbnailUrl, type, width, height }] }`. Max 50 drafts. |
| `POST /drafts/media` (multipart `image` / `video` / `reel` / `thumbnail`) | Uploads media for a draft and returns `{ media }`. A draft may only reference media returned here. |
| `GET /bin?page` | `{ items: [{ _id, kind: post\|story, originalId, preview: { postType, contentType, caption, thumbnailUrl, mediaType }, deletedAt, purgeAfter, daysLeft }] }` |
| `POST /bin/:binId/restore` | Puts it back under its original id, with likes, comments and saves. A story whose 24 hours have passed goes back to the archive. |
| `DELETE /bin/:binId`, `DELETE /bin` | Delete now / empty the Bin. |

## Email (#10)

- Daily digest at 09:10 IST of unread activity and messages, at most one a day. Turn it off per category in `activity-settings`.
- `GET` / `POST /email/unsubscribe?u&c&t` is the signed link in the email; the POST is mail apps' one-click unsubscribe.
- Environment: `EMAIL_DIGEST_ENABLED=false` turns the job off. `EMAIL_DIGEST_MAX_PER_RUN` (default 1000) caps sends per run to stay under the Zoho daily limit. `EMAIL_UNSUBSCRIBE_SECRET` signs the links (falls back to `ACCESS_TOKEN_SECRET`).

## New notification types

`story_like`, `story_comment`, `repost`, `collab_invite`, `collab_accepted`, `milestone` (with `data.views`), plus `mention`. They have a new `storyId` field and an optional `data` field.

## Admin settings

`CONTENT_CATEGORIES` (list of strings), `VIEW_MILESTONES` (list of numbers, default `[50, 100, 500]`), `BIN_RETENTION_DAYS` (number, default 15).

## Background jobs

| Job | When |
|---|---|
| Bin purge | Daily, 03:20 IST |
| Trending topics | Every 30 minutes |
| Trending near you / hot deals | Every 3 hours |
| Email digest | Daily, 09:10 IST |
