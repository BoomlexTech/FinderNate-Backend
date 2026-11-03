# Phase 3 API (chat and privacy)

Base URL: `/api/v1`. All responses use the usual `{ statusCode, data, message }` envelope, and every endpoint needs a signed-in user. New fields are optional, so older app versions keep working.

## Group roles (#21)

Each group has an **owner**, **admins** and **members**. The permission rules are in `src/utils/chatRoles.rules.js`.

| Action | Owner | Admin | Member |
|---|---|---|---|
| Add members, rename, change picture, set the disappearing timer | ✔ | ✔ | ✖ |
| Remove or block members | ✔ | ✔ | ✖ |
| Remove or block admins | ✔ | ✖ | ✖ |
| Make or remove admins, hand over ownership | ✔ | ✖ | ✖ |
| Remove or block the owner | ✖ | ✖ | ✖ |
| Delete the group | ✔ | ✖ | ✖ |

When the owner leaves, ownership passes to the longest-serving admin. If there are no admins, it passes to the longest-serving member. Groups created before Phase 3 treat their creator as the owner.

| Method and path | Body | Notes |
|---|---|---|
| `GET /chats/:chatId/members` | – | Returns `{ ownerId, myRole, members: [{ user, role, joinedAt, isYou }], blocked, permissions: { canAddMembers, canEditInfo, canManageAdmins, canDeleteGroup } }`. Only the owner and admins receive `blocked`. |
| `POST /chats/:chatId/members` | `{ userIds: [] }` | Returns `{ added, skipped: [{ userId, reason }] }`. The reason is one of `already_member`, `not_found`, `blocked_in_group` or `blocked`. A group holds up to 256 members. |
| `DELETE /chats/:chatId/members/:memberId` | `?block=true` | Removes someone. With `block=true`, the person also can't be added back until they're unblocked. |
| `POST` / `DELETE /chats/:chatId/blocked/:memberId` | – | Block (this also removes the person) or unblock. |
| `POST` / `DELETE /chats/:chatId/admins/:memberId` | – | Make someone an admin, or remove them as admin. |
| `POST /chats/:chatId/owner` | `{ userId }` | Hands over the group. The old owner stays on as an admin. |
| `POST /chats/:chatId/leave` | – | Returns `newOwnerId` when the owner left. |
| `DELETE /chats/:chatId` | – | Owner only. |

The chat list carries `ownerId` and `myRole` for each group.

Every change posts a **system message** with `messageType: 'system'` and `system: { action, actorId, targetIds, data }`. An example is "Asha made Ravi an admin". The sentence is also stored in `message`, so older apps show it as text. The actions are:

- `group_created`, `members_added`, `member_removed`, `member_blocked`, `member_unblocked`, `member_left`
- `admin_added`, `admin_removed`, `owner_changed`
- `disappearing_on`, `disappearing_off`, `e2ee_on`

Socket events: `group_members_added`, `added_to_group` (sent to the new member), `group_member_removed`, `removed_from_group`, `group_roles_updated`, `group_member_left` (adds `newOwnerId`).

## Disappearing messages (#37)

| Method and path | Body | Notes |
|---|---|---|
| `PATCH /chats/:chatId/disappearing` | `{ seconds }` | `seconds` is 0 (off), 86400 (24 hours), 604800 (7 days) or 7776000 (90 days). The labels `'off'`, `'24h'`, `'7d'` and `'90d'` also work. In a direct chat, either person can change it; in a group, the owner and admins can. |

- Messages sent after the change get `expiresAt`. They disappear from every list as soon as they expire.
- A job runs every 5 minutes and deletes expired messages and their media files. Media still used by a forwarded copy elsewhere is kept. Each run emits `messages_expired { chatId, messageIds }`.
- Payment, checkout and order messages, calls and system notices never disappear.
- `chat.disappearing.seconds` appears in the chat list, and `GET /chats/:chatId/messages` returns `disappearingSeconds`. The socket event `chat_disappearing_updated` reports changes.

## View-once photos and videos (#48)

- **Sending:** add `viewOnce: true` to a photo or video message in a one-to-one chat. This works for both the multipart upload and the app's upload-first route, where the link arrives as `message`.
- **Hidden link:** lists, sockets, pinned messages and the chat list never include the media link. Each message instead carries `viewOnce: true` and `viewOnceState`, which is one of `ready`, `opened`, `expired` or `sent`. The text reads "📷 View-once photo".
- **Opening:** `POST /chats/:chatId/messages/:messageId/view-once` is for the recipient only and works once. It returns `{ mediaUrl, messageType, availableForSeconds: 300 }`. In an encrypted chat it returns `e2ee` in place of `mediaUrl`. Any later call gets 410. The sender is told through `view_once_opened`.
- **Deletion:** the file is deleted 5 minutes after it's opened. An unopened file is deleted after 14 days, and the job emits `view_once_expired`.
- **Restrictions:** view-once messages can't be forwarded or edited.
- **Apps:** apps should block saving and forwarding. The Android app also blocks screenshots while the photo is open.

## GIFs and stickers (#7)

| Method and path | Notes |
|---|---|
| `GET /gifs/trending?type=gifs\|stickers&limit&offset` | Returns `{ items: [{ id, type, title, url, mp4Url, previewUrl, width, height }], nextOffset, attribution }` |
| `GET /gifs/search?q=&type=&limit&offset` | Same shape. Results are cached for 1 hour; trending for 15 minutes. |

- **Sending:** use `POST /chats/:chatId/messages/text` with `{ messageType: 'gif' | 'sticker', gifId }`. The server looks the GIF up on GIPHY, so clients can't send arbitrary links. The message carries `gif: { id, title, url, mp4Url, previewUrl, width, height }`.
- **Environment:** `GIPHY_API_KEY` is required; without it the endpoints return 503. `GIPHY_RATING` is optional and defaults to `pg-13`.
- **Attribution:** show "Powered by GIPHY" in the picker.

## Several accounts on one device (#25)

| Method and path | Body | Notes |
|---|---|---|
| `POST /users/me/devices` | `{ token, platform: android\|ios\|web, installId?, appVersion?, accountIds: [...] }` | Registers the push token for the signed-in account without removing it from the device's other accounts. Send this for every account in `accountIds`, the list of accounts signed in on this device. Accounts missing from the list lose the token. Each device holds up to 5 accounts. |
| `DELETE /users/me/devices` | `{ token }` | Removes one account from this device's notifications. Other accounts on the device keep theirs. |
| `GET /users/me/devices` | – | Lists the devices that get this account's notifications. |

- **Delivery:** every push (messages, calls, activity) now goes to all of the recipient's devices. That covers phones registered through the new device list and the older `User.fcmToken`.
- **Account tags:** each FCM message carries `accountId` and `accountUsername`. When a phone holds more than one account, the title ends in "· @username". Web pushes carry the same fields.
- **Web push:** subscriptions are now stored per browser. An account signed in on two browsers gets notified on both, and one browser can hold several accounts.
- **Older apps:** `POST /users/fcm-token` keeps its one-account-per-device behaviour, and logout with `fcmToken` still removes that device.

## End-to-end encryption (#2, #40)

Encryption covers one-to-one chats first; group chats come later. The server stores only public keys and encrypted data.

### Algorithms

| Element | Choice |
|---|---|
| Device keys | X25519 for encryption and Ed25519 for signing. Each device has its own pair. |
| Message encryption | XChaCha20-Poly1305 (IETF) with a random 32-byte content key and a 24-byte nonce. The associated data is the chat id. |
| Key wrapping | For each reading device: shared secret = X25519(ephemeralPriv, devicePub), then wrapKey = SHA-256(`"findernate-e2ee-wrap-v1"` ‖ shared ‖ ephemeralPub ‖ devicePub). The content key is encrypted with XChaCha20-Poly1305 under wrapKey, with no associated data. |
| Signature | Ed25519 over `ciphertext ‖ nonce ‖ ephemeralPub ‖ utf8(chatId)`, using the raw decoded bytes. Recipients reject a message whose signature doesn't verify against the sender's device key. |
| Backup PIN | PBKDF2-HMAC-SHA256 (at least 200,000 iterations) with a 16-byte salt, producing 32 bytes. The keyring JSON is encrypted with XChaCha20-Poly1305. |

### Endpoints

| Method and path | Body | Notes |
|---|---|---|
| `PUT /e2ee/devices/:deviceId` | `{ encPublicKey, signPublicKey, platform, name }` | Registers this device's keys, base64 encoded. Call it on every start. A device's keys never change (409 if they differ), so new keys need a new deviceId. A user can have up to 10 devices; the quietest one is retired beyond that. |
| `GET /e2ee/devices`, `DELETE /e2ee/devices/:deviceId` | – | Your devices, or remove one (on sign-out). |
| `GET /e2ee/keys?userIds=a,b` | – | Returns `{ users: { [id]: { enabled, devices: [{ userId, deviceId, encPublicKey, signPublicKey }] } } }`. A one-to-one chat is encrypted when both people have `enabled: true`. |
| `POST /e2ee/blobs` (multipart `file`) | – | Uploads an encrypted attachment byte for byte and returns `{ url }`. |
| `GET` / `PUT` / `DELETE /e2ee/backup` | `{ kdf: { alg: 'pbkdf2-sha256', iterations, salt }, nonce, ciphertext, deviceCount, expectedVersion? }` | The PIN-encrypted keyring. A PUT with an out-of-date `expectedVersion` gets 409. The GET is limited to 10 an hour. |

### Sending an encrypted message

`POST /chats/:chatId/messages/text` with:

```json
{
  "messageType": "encrypted",
  "e2ee": {
    "v": 1,
    "senderDeviceId": "…",
    "ephemeralPublicKey": "…",
    "nonce": "…",
    "ciphertext": "…",
    "signature": "…",
    "keys": [{ "deviceId": "…", "nonce": "…", "wrappedKey": "…" }]
  },
  "e2eeBlobUrls": ["…"],
  "viewOnce": false,
  "replyTo": "…"
}
```

- **What the ciphertext holds:** the JSON `{ type: text|image|video|audio|file|gif|sticker|location, text?, media?: { url, key, nonce, mime, size, name, duration, width, height }, gif?, location? }`. Media files are encrypted with their own key before upload; the key and nonce travel only inside the ciphertext.
- **Device coverage:** `keys` must cover every device of both people, including the sender's other devices. If a device is missing, the server answers 409 with `data.code = 'E2EE_DEVICES_CHANGED'` and `data.devices`. Re-wrap for those devices and send again. The socket event `e2ee_devices_changed` tells clients to refresh keys.
- **Chat status:** the first encrypted message turns on `chat.e2ee.enabled` and posts the `e2ee_on` system notice.
- **Chat list:** `lastMessage.e2ee` carries the envelope, so the device can show a real preview.
- **Push:** notifications say "🔒 New message" and include `data.e2ee = '1'`.
- **Editing:** `PATCH …/edit` with `{ e2ee }` replaces the envelope.
- **Forwarding:** the server answers `E2EE_FORWARD_ON_DEVICE`. The app decrypts the message and sends it again as a new message.
- **Not encrypted:** payment links, checkout and order updates stay as server messages and are labelled that way in encrypted chats.
- **Search:** server-side search skips encrypted messages.
- **Reports:** `POST /reports` with `type: 'user'` accepts `attachedMessages: [{ messageId, text, mediaUrl? }]`, up to 20, which the reporter's device decrypts. Only messages the reported user sent, in a chat the reporter belongs to, are kept.
- **Calls:** unchanged, with no lock icon, until Stream confirms end-to-end encryption in both SDKs.

### Limits

- **Forward secrecy:** each message uses a fresh ephemeral key, but there's no ratchet. Anyone who obtains a device's private key can read that device's messages.
- **Backup PIN:** the PIN protects the backup only as well as the PIN itself. The server can't read the backup, but someone holding a copy of the database could try every 6-digit PIN offline. Recommend a longer passphrase.
- **Safety code:** this lets two people confirm the server hasn't swapped a key. Compute d = SHA-512(utf8(the base64 signing keys of both people's devices, sorted and joined with ",")). Group i (0–11) is (d[3i]·65536 + d[3i+1]·256 + d[3i+2]) mod 100000, shown as 5 digits.

## Background jobs

| Job | When |
|---|---|
| Disappearing messages and view-once media clean-up | Every 5 minutes |
