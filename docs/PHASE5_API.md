# Phase 5 API (creator tools)

Base URL: `/api/v1`. Responses use the usual `{ statusCode, data, message }` envelope. Unless a route says otherwise, it needs a signed-in user.

| What | Items |
|---|---|
| Music on posts, vibes and stories | #29 |
| Video editor: trim, merge, transitions, effects, text, stickers, price tags, music | #34, #62 |
| One-tap reel camera (uses the same editor endpoints) | #66 |
| Duet and reaction videos | #49 |
| Interactive story stickers: poll, quiz, emoji slider, countdown, "Ask me anything" | #47 |
| Photo enhancer | #35 |

## The server needs FFmpeg

Rendering happens on the server, so the apps stay small and the website and the apps edit the same way.

- The `ffmpeg-static` package ships a FFmpeg program with the backend (it is an optional dependency, installed by `npm ci`).
- To use another one, set `FFMPEG_PATH`. If neither works, `GET /edits/config` answers `available: false` and the clients hide the editor, music mixing and duets. Nothing else is affected.
- The worker logs `🎬 [creator] worker started` at boot, or a warning if FFmpeg was not found.
- Rendering one minute of video takes a few CPU-minutes on a small server. Jobs run one at a time per server (`EDIT_WORKER_CONCURRENCY`) and at low CPU priority. If editing grows, run a second server with `EDIT_WORKER_ENABLED=false` on the one that takes requests.

## Music (#29)

There are two kinds of sounds.

- **`library`**: royalty-free tracks that your admins upload (Admin → Sounds on the website, or `POST /admin/sounds`). Each track records its licence and attribution.
- **`original`**: the sound of someone's own vibe. When a vibe is published, a background job pulls its sound out and turns it into "Original audio · @name". Anyone can then tap **Use this audio**. Not created when the vibe already has music, is a duet, has no sound or only silence. A private account's audio is kept but is not offered for reuse. The creator can switch reuse off with `PATCH /sounds/:id { allowReuse }`.

Film and pop songs are not included: they need a licence from the labels first.

| Method and path | Notes |
|---|---|
| `GET /sounds?q&source=library\|original&genre&mood&language&sort=trending\|new&page&limit` | Optional sign-in. The library by default; a search (`q`) also looks through original audio. `genres` (for filter chips) comes with page 1. |
| `GET /sounds/saved`, `POST /sounds/:id/save`, `DELETE /sounds/:id/save` | Saved sounds. |
| `GET /sounds/:id` | The sound, with `postsCount`, `owner` (original audio) and `canReuse`. |
| `GET /sounds/:id/posts?page&limit` | Public posts that use the sound (same visibility rules as hashtag pages). |
| `PATCH /sounds/:id` `{ allowReuse }` | The creator of original audio only. |

A sound looks like `{ _id, source, title, artist, audioUrl, coverUrl, durationSec, genre, mood, usageCount, allowReuse, isSaved, attribution }`.

### Putting a sound under content

The choice is `{ soundId, startSec, durationSec, volume, originalVolume, fadeIn, fadeOut }`. `durationSec` is at most 90 for posts and vibes and 15 for stories. The server reads the song's details itself; only the window and the volumes come from the client.

| Content | How |
|---|---|
| **Photo post** | Send `music` (JSON) with the create request. The post stores `music` with `mixed: false`; the app plays `music.audioUrl` from `startSec` for `durationSec`, looping, while the post is on screen. |
| **Video post or vibe** | Send the music inside the edit (below). The server mixes it into the video's audio, and the post gets `music` with `mixed: true` (a label only; do not play it again). Sending `music` with a video and no `editId` answers 400. |
| **Story, photo** | `music` field on `POST /stories/upload`, like a photo post. |
| **Story, video** | Through an edit, then `editId` on `POST /stories/upload`. |

`post.music` = `{ soundId, source, title, artist, audioUrl, coverUrl, startSec, durationSec, volume, mixed }`. It comes back on home feed cards, explore cards, vibes and post detail.

### Admin

| Method and path | Notes |
|---|---|
| `GET /admin/sounds?status=active\|hidden\|held\|removed&source&q&page` | Needs the `deleteContent` permission. |
| `POST /admin/sounds` (multipart: `audio`, optional `cover`; `title`, `artist`, `genre`, `mood`, `language`, `licenceType`, `provider`, `attribution`, `licenceUrl`) | MP3 or M4A up to 15 MB and 10 minutes. `licenceType`: `royalty_free`, `cc0`, `cc_by`, `licensed`. |
| `PATCH /admin/sounds/:id` `{ title, artist, genre, mood, language, status: active\|hidden, allowReuse }` | Hiding a track stops it being picked; posts that use it keep playing. |
| `DELETE /admin/sounds/:id` | Only when no post or story uses it (409 otherwise: hide it instead). |

## Video editor (#34, #62, #66)

The flow, for the app and the website:

1. `GET /edits/config`: whether editing is on, the limits, the filter, transition and duet-layout names.
2. `POST /edits`: send the clips and the choices. Answers **202** with an edit in `queued`.
3. `GET /edits/:id` every second or two until `status` is `done` (or `failed`, with a message in `error`). `progress` runs 0 to 100.
4. Create the post or story with `editId` set to the finished edit.

`POST /edits` is multipart:

| Field | |
|---|---|
| `clips` | 1 to 6 video files, each up to 200 MB. |
| `overlays` | Up to 20 **PNG** images (see below). |
| `edl` | JSON text with the choices. |

```json
{
  "clips": [
    { "input": 0, "trimStart": 1.2, "trimEnd": 6.5, "speed": 1, "mute": false, "volume": 1,
      "filter": "warm", "fit": "cover", "crop": { "x": 0, "y": 0, "width": 1, "height": 1 } }
  ],
  "transitions": [ { "type": "fade", "duration": 0.5 } ],
  "filter": "none",
  "overlays": [ { "input": 0, "x": 0.5, "y": 0.2, "width": 0.6, "start": 0, "end": 3 } ],
  "music": { "soundId": "…", "startSec": 12, "durationSec": 20, "volume": 0.8, "originalVolume": 0.6 },
  "coverAt": 1.5
}
```

- `input` is the position of the file in `clips` (or `overlays`). Leave `clips` out to use every file whole, in order.
- `transitions[i]` sits between clip `i` and `i + 1`. A transition longer than half of either clip is shortened; one that would be a blink is dropped.
- `speed` is 0.25 to 4. `fit` is `cover` (fill, crop the edges) or `contain` (black bars). `crop` and `x`, `y`, `width` are fractions from 0 to 1.
- `filter` is one of `none, warm, cool, vivid, fade, mono, noir, vintage, sunset`. These are plain colour filters; no AR face effects.
- `transitions[].type` is one of `fade, dissolve, fade_black, wipe_left, wipe_right, slide_left, slide_right, slide_up, slide_down, circle_open, circle_close, pixelize, zoom, radial`.
- **Text, stickers and price tags are pictures.** The client draws each one as a transparent PNG (so every language and emoji looks the same as in the preview) and the server only places it: `x` and `y` are the centre of the picture as a fraction of the frame, `width` is a fraction of the frame width, and `start` / `end` are seconds on the final timeline (`end` left out means until the end).
- Anything that is not a recognised name or a number is ignored. Nothing the client sends is passed to FFmpeg as text.
- The result is a 1080×1920, 30 fps MP4 with sound (silence if the clips had none), up to 3 minutes (`EDIT_MAX_OUTPUT_SECONDS`).

An edit looks like `{ _id, kind, status: queued|processing|done|failed|expired, progress, error?, result?: { url, thumbnailUrl, coverUrl, duration, width, height, processing }, duet?, music? }`.

`DELETE /edits/:id` throws a finished result away (409 once a post uses it). Results nobody used are deleted after 48 hours.

Answers you can show people: 429 when 2 edits are already running for them or they made 30 today (`EDIT_MAX_ACTIVE_PER_USER`, `EDIT_DAILY_LIMIT`); 503 when editing is off; 400 with a plain message for a clip that cannot be read, a PNG that is not a PNG, too many clips, or a video that is too long.

### Using the result

Every create endpoint (`POST /posts/...` for normal, product, service and business posts, the batch endpoint with `editId` per post, and `POST /stories/upload`) accepts `editId` in place of the media file. A finished edit that is still being prepared answers 409; one that failed answers 410. The apps' "Post" button can stay disabled until `done`.

For the one-tap reel camera (#66), the app records, then sends the recording to `POST /edits` with the chosen music and filter; there is no separate API.

## Duets and reactions (#49)

`POST /edits/duet` (multipart: `clips` with exactly one file, optional `overlays`, `originalPostId`, and `edl` with `{ "duet": { "layout": "side_by_side|top_bottom|reaction", "muteOriginal": false, "muteMine": false }, "music": …, "overlays": …, "filter": … }`).

- Layouts: `side_by_side` (two panes in the middle of the 9:16 frame), `top_bottom` (two panes filling the frame), `reaction` (the original full screen with your video in a corner).
- The result is as long as the shorter of the two videos.
- Only vibes and videos can be dueted. Not allowed (403) when the creator turned duets off (`PATCH /posts/:id/interaction-settings { allowDuets: false }`, or `settings.allowDuets` when creating), the account is private, either person blocked the other, or the video is gone. A creator can always duet their own video.
- When the duet is published (the create request with `editId`), the new post carries `duet: { postId, authorId, authorUsername, layout }`, which the clients show as "Duet with @name", and the original's creator is notified (`type: duet`). Credit text drawn into the video, if you want it, is just another PNG layer.

## Interactive story stickers (#47)

Send `stickers` (JSON) with `POST /stories/upload`. Up to 5 per story.

```json
[
  { "type": "poll", "x": 0.5, "y": 0.6, "scale": 1, "rotation": 0, "data": { "question": "Tea or coffee?", "options": ["Tea", "Coffee"] } },
  { "type": "quiz", "data": { "question": "2 + 2?", "options": ["3", "4"], "correctIndex": 1 } },
  { "type": "slider", "data": { "question": "How much do you love it?", "emoji": "😍" } },
  { "type": "countdown", "data": { "title": "Sale starts", "endsAt": "2026-12-01T09:00:00Z" } },
  { "type": "question", "data": { "prompt": "Ask me anything" } }
]
```

Polls have 2 to 4 answers (Yes / No when none are given). The server adds an `id` to each sticker.

In story responses (`/stories/feed`, `/stories/user/:id`, `/stories/archived/:id`, and the upload reply) each story with stickers carries:

- `stickers`: the stickers. A quiz's `correctIndex` is removed for everyone except the owner.
- `stickerState`: one summary per sticker for the person asking, e.g. `{ id, type, answered, myChoice, counts, percents, total }`. People see the results of a poll, quiz or slider only after answering; the owner always does. A quiz also returns `isCorrect`, `correctIndex` and `correctCount` after answering. A countdown returns `isReminded` (and `reminders` for the owner).

| Method and path | Notes |
|---|---|
| `POST /stories/:storyId/stickers/:stickerId/respond` | Body by type: `{ choice }` (poll, quiz), `{ value: 0..1 }` (slider), `{ text }` (question, up to 300 characters), `{ remind: true\|false }` (countdown, can be switched back). Answers once: a second answer is 409 with the current results. Returns the sticker's summary. The story's owner cannot answer their own sticker. |
| `GET /stories/:storyId/stickers/results` | Owner only, also on archived stories. Per sticker: the summary, `responders` (who chose or slid what) or `questions` (who asked what, with any reply). |
| `POST /stories/:storyId/stickers/:stickerId/questions/:responseId/reply` `{ text }` | The owner answers a question; the asker is notified (`story_question_reply`). |

Notifications: a new question (`story_question`) goes to the owner; a countdown reminder (`story_countdown`) goes to everyone who tapped "Remind me" when it ends. Polls, quizzes and sliders do not notify.

A story that has poll, quiz, slider or question answers is **kept in the archive** after its 24 hours instead of being deleted, so the owner can read the results (as with likes and comments).

## Photo enhancer (#35)

| Method and path | Notes |
|---|---|
| `GET /enhance/config` | `{ available, modes: { auto, removeBackground }, usage: { used, limit, remaining, resetsAt, tier } }` |
| `POST /enhance` (multipart: `image` up to 10 MB; `mode` = `auto` (default) or `remove_background`; `background` = `#rrggbb` or `transparent`, default white) | Returns `{ image: "data:image/…;base64,…", width, height, mode, usage }`. Nothing is stored. Show it next to the original as a before / after. |

- **`auto`**: lighting fix and sharpening. Free and built in.
- **`remove_background`**: through Photoroom. Needs `PHOTOROOM_API_KEY`; without it `modes.removeBackground` is false and the mode answers 503.
- A monthly allowance per plan (calendar month, India time): **5** free, **30** Small Business, **100** Corporate. A photo that cannot be processed does not use one up. Over the allowance: 429 with a message.

## Settings (admin settings, all optional)

| Key | Default | For |
|---|---|---|
| `CREATOR_EDITS_ENABLED` | true | Switch the editor off everywhere |
| `EDIT_MAX_OUTPUT_SECONDS` | 180 | Longest edited video |
| `EDIT_MAX_ACTIVE_PER_USER`, `EDIT_DAILY_LIMIT` | 2, 30 | Per person |
| `ENHANCE_ENABLED` | true | Photo enhancer |
| `ENHANCE_LIMIT_FREE`, `ENHANCE_LIMIT_SMALL_BUSINESS`, `ENHANCE_LIMIT_CORPORATE` | 5, 30, 100 | Uses per month (0 turns it off for that plan) |

## Environment

| Variable | |
|---|---|
| `PHOTOROOM_API_KEY` | Background removal. Optional. `PHOTOROOM_API_URL` overrides the address. |
| `FFMPEG_PATH` | Use this FFmpeg instead of the bundled one. |
| `EDIT_WORKER_ENABLED`, `EDIT_WORKER_CONCURRENCY`, `EDIT_WORKER_ALL_INSTANCES` | Worker control. The worker runs on the first instance only unless the last one is `true`. |
| `EDIT_TMP_DIR` | Where uploads wait while rendering (default: the system temp folder). Needs room for a few hundred MB. |
| `EDIT_FFMPEG_PRESET`, `EDIT_FFMPEG_CRF`, `EDIT_FFMPEG_THREADS`, `EDIT_RENDER_TIMEOUT_MS`, `EDIT_OUTPUT_WIDTH`, `EDIT_OUTPUT_HEIGHT` | Quality and speed knobs (defaults: `veryfast`, 23, automatic, 12 minutes, 1080 × 1920). |

## Jobs

| Job | When |
|---|---|
| Countdown reminders | Every 5 minutes |
| Cleanup of unused edit results (after 48 hours), stuck edits (after 2 hours), stray temp files | Hourly |
| Original audio whose vibe is gone, removed sounds nobody plays | Daily 03:40 IST |
| Original audio extraction | A queue job 20 seconds after a vibe is published (retries while the video is still being encoded) |
