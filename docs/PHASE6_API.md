# Phase 6 API (the features that were left)

Base URL: `/api/v1`. Responses use the usual `{ statusCode, data, message }` envelope. Unless a route says otherwise, it needs a signed-in user.

This file grows as each feature lands. Nothing here changes an existing endpoint: older apps simply don't show the new things.

## Polls on posts (#72)

A person can add a poll to a photo post, a text post (note), a product or a service. Not to vibes or stories (stories have the poll sticker).

**The rules**
- **Question and answers:** a question up to 140 characters, and 2 to 4 different answers of up to 60 characters. Answers that differ only by capital letters count as the same.
- **How long:** from 1 hour to 30 days. The default is 7 days.
- **Votes:** one vote per person, and it can't be changed or taken back. The author can't vote on their own poll.
- **Who sees the numbers:** the author, anyone who has voted, and everyone once the poll has ended. Anyone else gets the question and the answers only. The counts are left out, not set to zero.
- **No edits:** a poll can't be edited after the post is published, since that would change what people voted on.
- **Scheduled posts:** the clock starts when the post goes live, not when it was written.

**Creating one.** Send `poll` with any of the create routes (`/posts/create/normal`, `/tweet`, `/product`, `/service`, `/business`). It is a JSON object, or a JSON string in a multipart form:

```json
{ "question": "Tea or coffee?", "options": ["Tea", "Coffee"], "durationHours": 24 }
```

A bad poll answers 400 with a sentence the author can read ("A poll needs at least 2 answers.", "Each answer has to be different.", …).

The post then carries `poll: { question, options: [text], endsAt }`. It is in the home feed and trending cards, and in the post detail and profile grids. The counts and the viewer's own vote come from the calls below.

| Method and path | Body | Notes |
|---|---|---|
| `POST /posts/:postId/poll/vote` | `{ choice }` | `choice` is the number of the answer, starting at 0. Answers 200 with the poll as the voter now sees it. 409 if they already voted (the body still carries the poll). 400 if it has ended. 403 for the author. 404 if the post has no poll or the viewer can't see the post. |
| `GET /posts/:postId/poll` | – | Works signed out. Returns the poll as this viewer sees it. |
| `POST /posts/polls/batch` | `{ postIds: [...] }` | Works signed out. Up to 30 ids. Returns `{ polls: { [postId]: poll } }`. Posts with no poll, or that the viewer can't see, are left out (not an error), so a client can ask about a whole feed page at once. |

**A poll as a viewer sees it**

```json
{
  "question": "Tea or coffee?",
  "endsAt": "2026-11-15T10:00:00.000Z",
  "ended": false,
  "voted": true,
  "myChoice": 1,
  "canSeeResults": true,
  "totalVotes": 4,
  "options": [
    { "index": 0, "text": "Tea",    "votes": 3, "percent": 75 },
    { "index": 1, "text": "Coffee", "votes": 1, "percent": 25 }
  ]
}
```

When `canSeeResults` is false, `totalVotes` is `null` and each option is just `{ index, text }`.

**Data.** Votes are stored in `PostPollVote`, one row per person per post. They stay while a post sits in the Bin, so a restored post keeps its votes. They are deleted when the post is deleted for good (the Bin purge, an admin removal, closing a business) and when an account is closed.

## Heart vibration (#79)

No server change. The apps and the website give a short tap along with the heart on a double-tap like.

## Sharing without signing in (#7)

No server change. The share routes `POST /share/post/:postId/generate`, `POST /share/reel/:postId/generate` and `POST /share/track` still need an account; a signed-out visitor never calls them. The website and the app build the public link (`/r/:postId`) themselves, and `GET /share/post/:postId` and `GET /share/reel/:postId` already work without one. The only change is in the app: "Followers" in the share sheet now asks a signed-out visitor to sign in instead of failing.

## Story sticker position

No server change. A sticker is saved as a fraction of the box it was placed in (`x`, `y` from 0 to 1). The composers now place stickers in a box with the same shape as the one the viewer draws a story in, and show the picture the way the viewer does, so a sticker lands on the same part of the picture.

## In-app camera and live duet (#61, #78)

No server change. The app's camera records the clip, and the clip then goes through the same calls as before: `POST /edits` for a vibe, and `POST /edits/duet` with the original post for a duet (see `PHASE5_API.md`). For a duet the original plays beside your own camera while you record, in the layout you picked, placed the way the server joins the two (`side_by_side`, `top_bottom`, `reaction`), so what you see while recording is what comes out. A duet is as long as the shorter of the two videos, up to 60 seconds.

## Stickers and price tags in the app's video editor (#37)

No server change. The editor already sends text layers as pictures (`overlays` in the edit list, see `PHASE5_API.md`). Stickers and price tags are drawn the same way, so the server places them like any other layer.
