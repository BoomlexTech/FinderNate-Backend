import mongoose from "mongoose";

// 🌐 GeoJSON for location
const GeoJSONPointSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
    },
    coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        index: '2dsphere'
    }
}, { _id: false });

//  Media
const MediaDimensionsSchema = new mongoose.Schema({
    width: Number,
    height: Number
}, { _id: false });

const AdditionalMediaSchema = new mongoose.Schema({
    url: String,
    thumbnailUrl: String,
    dimensions: MediaDimensionsSchema,
    order: Number
}, { _id: false });

const MediaSchema = new mongoose.Schema({
    type: String, // "image" or "video"
    url: String,
    thumbnailUrl: String,
    duration: Number,
    dimensions: MediaDimensionsSchema,
    fileSize: Number,
    format: String,
    // Bunny Stream encodes after the upload call returns, so the URL is valid
    // for ~10-30s before anything will actually play. Clients show the
    // thumbnail while this is true; the Stream webhook clears it. Images and
    // Storage-hosted video are never in this state.
    processing: { type: Boolean, default: false },
    // Comma-separated ladder Bunny actually produced, e.g. "360p,480p".
    // Bunny never upscales, so this varies per source video — clients must
    // check it before requesting a smaller rendition on a slow connection,
    // or they will ask for a file that was never encoded.
    availableResolutions: String,
    // Phase 2 #3: the display format this item was framed for ('4:5', '1:1',
    // '1.91:1', or '9:16' for vibes) and, for videos, the area to show. Photos
    // are cropped on the device before upload, so they never carry `crop`.
    // Videos are uploaded whole and cropped at playback time (object-fit:
    // cover plus this window), which keeps FFmpeg off the API servers and lets
    // the frame be adjusted later without re-encoding. All values are 0..1
    // fractions of the source frame. Absent on media posted before #3.
    aspect: String,
    crop: {
        type: new mongoose.Schema({
            x: Number,
            y: Number,
            width: Number,
            height: Number
        }, { _id: false }),
        default: undefined
    },
    additionalMedia: [AdditionalMediaSchema]
}, { _id: false });

// 🛍 Product Details
const ProductVariantSchema = new mongoose.Schema({
    name: String,
    options: [String]
}, { _id: false });

const ProductSpecificationSchema = new mongoose.Schema({
    key: String,
    value: String
}, { _id: false });

const ProductDetailsSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    // Phase 2 #42: the "was" price (MRP). A product with originalPrice above
    // price is a deal; the discount is computed, never stored.
    originalPrice: Number,
    currency: String,
    category: String,
    subcategory: String,
    brand: String,
    sku: String,
    availability: String,
    inStock: { type: Boolean, default: true },
    variants: [ProductVariantSchema],
    specifications: [ProductSpecificationSchema],
    images: [String],
    tags: [String],
    weight: Number,
    dimensions: {
        length: Number,
        width: Number,
        height: Number,
        unit: String
    },
    // 🚚 Delivery Options
    deliveryOptions: {
        type: String,
        enum: ['online', 'offline', 'both'],
        required: true,
        default: 'online'
    },
    // 💰 Shipping & GST (set by seller)
    shippingCharges: {
        type: Number,
        default: 0,
        min: 0
    },
    gstPercent: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    location: {
        name: String,
        address: String,
        city: String,
        state: String,
        country: String,
        coordinates: GeoJSONPointSchema
    },
    link: { type: String },

}, { _id: false });

// 💼 Service Details
const ServiceAvailabilitySchema = new mongoose.Schema({
    schedule: [{
        day: String,
        isClosed: { type: Boolean, default: false },
        timeSlots: [{
            startTime: String,
            endTime: String
        }]
    }],
    timezone: String,
    bookingAdvance: Number,
    maxBookingsPerDay: Number
}, { _id: false });

const ServiceLocationSchema = new mongoose.Schema({
    type: String,
    address: String,
    city: String,
    state: String,
    country: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const ServiceDetailsSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    currency: String,
    category: String,
    subcategory: String,
    duration: Number,
    durationUnit: { type: String, enum: ['minutes', 'hours'], default: 'minutes' },
    serviceType: String,
    // 🚚 Delivery Options
    deliveryOptions: {
        type: String,
        enum: ['online', 'offline', 'both'],
        required: true,
        default: 'online'
    },
    // 💰 Shipping & GST (set by seller)
    shippingCharges: {
        type: Number,
        default: 0,
        min: 0
    },
    additionalCharges:{
        type: Number,
        default: 0,
        min: 0
    },
    gstPercent: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    availability: ServiceAvailabilitySchema,
    location: ServiceLocationSchema,
    requirements: [String],
    deliverables: [String],
    tags: [String],
    link: { type: String },
    isCurrentlyAvailable: { type: Boolean, default: true },

}, { _id: false });

// 🏢 Business Details
const BusinessContactSchema = new mongoose.Schema({
    phone: String,
    email: String,
    website: String,
    socialMedia: [{
        platform: String,
        url: String
    }]
}, { _id: false });

const BusinessLocationSchema = new mongoose.Schema({
    // Present on every other location shape in this file (the generic one at
    // customization.normal.location, and ServiceLocationSchema) and missing
    // only here — so the website's business Location input, which writes to
    // business.location.name, was silently discarded by Mongoose on save.
    name: String,
    address: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const BusinessHoursSchema = new mongoose.Schema({
    day: String,
    openTime: String,
    closeTime: String,
    isClosed: Boolean
}, { _id: false });

const BusinessPromotionSchema = new mongoose.Schema({
    title: String,
    description: String,
    discount: Number,
    validUntil: Date,
    isActive: Boolean
}, { _id: false });

const BusinessDetailsSchema = new mongoose.Schema({
    businessName: String,
    businessType: String,
    description: String,
    category: String,
    subcategory: String,
    // 🚚 Delivery Options
    deliveryOptions: {
        type: String,
        enum: ['', 'online', 'offline', 'both'],
        required: true,
        default: ''
    },
    contact: BusinessContactSchema,
    location: BusinessLocationSchema,
    hours: [BusinessHoursSchema],
    features: [String],
    priceRange: String,
    rating: Number,
    tags: [String],
    announcement: String,
    promotions: [BusinessPromotionSchema],
    link: { type: String }
}, { _id: false });

// 🧍 Normal Post Details (with fixed GeoJSON)
const NormalLocationSchema = new mongoose.Schema({
    name: String,
    address: String,
    coordinates: GeoJSONPointSchema
}, { _id: false });

const NormalDetailsSchema = new mongoose.Schema({
    mood: String,
    activity: String,
    location: NormalLocationSchema,
    tags: [String]
}, { _id: false });

// 🎨 Customization Options
const CustomizationSchema = new mongoose.Schema({
    product: ProductDetailsSchema,
    service: ServiceDetailsSchema,
    business: BusinessDetailsSchema,
    normal: NormalDetailsSchema
}, { _id: false });

// 📊 Engagement
const EngagementSchema = new mongoose.Schema({
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    saves: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 }
}, { _id: false });

// ⚙️ Settings
const SettingsSchema = new mongoose.Schema({
    visibility: String,
    privacy: {
        type: String,
        enum: ['public', 'private'],
        default: 'public'
    },
    isPrivacyTouched: {
        type: Boolean,
        default: false
    },
    allowComments: Boolean,
    allowLikes: Boolean,
    allowShares: Boolean,
    allowSaves: Boolean,
    commentsFilter: String,
    hideLikeCount: Boolean,
    allowDownload: Boolean,
    // Phase 5 #49: undefined means duets are allowed.
    allowDuets: Boolean,
    customAudience: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { _id: false });

// 📈 Analytics
const AnalyticsSchema = new mongoose.Schema({
    clickThroughs: Number,
    inquiries: Number,
    conversions: Number,
    topCountries: [String],
    topAgeGroups: [String],
    genderDistribution: {
        male: Number,
        female: Number,
        other: Number
    },
    peakViewingTimes: [{
        hour: Number,
        count: Number
    }]
}, { _id: false });

// 🤝 Collab posts (Phase 2 #50/#57). The owner invites; the invitee accepts or
// declines. Only 'accepted' entries are shown on the post and put it on the
// collaborator's profile. Either side can end it: the owner by removing the
// entry, the collaborator by removing themselves.
const CollaboratorSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null }
}, { _id: false });

// 🎵 Music under a post, vibe or story (Phase 5 #29). The details are copied from
// the Sound at publish time so a feed card needs no second lookup. `mixed` is
// true when the song is already part of the video's audio (vibes and stories
// that went through the editor); for photos the app plays `audioUrl` itself,
// starting at `startSec` for `durationSec`.
export const MusicSchema = new mongoose.Schema({
    soundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sound' },
    source: { type: String, enum: ['library', 'original'] },
    title: String,
    artist: String,
    audioUrl: String,
    coverUrl: String,
    startSec: Number,
    durationSec: Number,
    volume: Number,
    mixed: { type: Boolean, default: false }
}, { _id: false });

// 🎭 Duet / reaction (Phase 5 #49): the video this one answers.
export const DuetSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorUsername: String,
    layout: String
}, { _id: false });

// 📬 Post Schema
const PostSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postType: { type: String, required: true, enum: ['photo', 'reel', 'video', 'story', 'tweet'] },
    contentType: { type: String, required: true, enum: ['normal', 'product', 'service', 'business'] },
    caption: String,
    description: String,
    /**
     * The category chosen in the composer.
     *
     * The website has always collected this and BLOCKED submission until it was
     * filled in, then sent it as a top-level field that no create controller
     * read and no schema path accepted — so Mongoose dropped it silently. A
     * required field that is thrown away on arrival.
     *
     * Kept at the top level rather than folded into customization.<type>
     * .category, because the composer asks for it on every post type including
     * normal, which has no customization object of its own.
     */
    category: String,
    customCategory: String,
    // Phase 2 #17: up to 10 free-text subcategories, searchable and filterable.
    // The single customization.<type>.subcategory is kept in step with the
    // first entry for older clients.
    subcategories: { type: [String], default: undefined },
    hashtags: [String],
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Phase 2 #53: one top-level comment the post owner pinned.
    pinnedCommentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    // Phase 2 #50/#57
    collaborators: { type: [CollaboratorSchema], default: undefined },
    // Phase 5
    music: { type: MusicSchema, default: undefined },
    duet: { type: DuetSchema, default: undefined },
    // Phase 2 #46: view thresholds the owner has already been told about.
    viewMilestones: { type: [Number], default: undefined, select: false },
    media: [MediaSchema],
    customization: {
        product: ProductDetailsSchema,
        service: ServiceDetailsSchema,
        business: BusinessDetailsSchema,
        normal: NormalDetailsSchema
    },
    engagement: EngagementSchema,
    settings: SettingsSchema,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    scheduledAt: Date,
    publishedAt: Date,
    status: String,
    isPromoted: Boolean,
    isFeatured: Boolean,
    isReported: Boolean,
    reportCount: Number,
    analytics: AnalyticsSchema
});

// 🏷 Auto-extract hashtags
function extractHashtags(text) {
    const regex = /#(\w+)/g;
    const tags = new Set();
    let match;
    while ((match = regex.exec(text))) {
        tags.add(match[1].toLowerCase());
    }
    return [...tags];
}

// 🪝 Pre-save hook for hashtags
// Sources: '#word' typed inline in caption/description PLUS the tags entered in
// the composer's "Add hashtags" field, which the create controllers store under
// customization.<type>.tags. This hook used to take the caption/description
// only and overwrite everything else, so `hashtags` was empty on virtually every
// post and hashtag search had nothing to match.
/**
 * Derives the hashtag index from a post's text and its composer tags.
 *
 * Exported so the EDIT path can reuse it. editPost goes through
 * findByIdAndUpdate, which does not fire the pre('save') hook below, and it
 * previously left `hashtags` untouched — a tag removed in an edit still matched
 * in search, and one added never did. Two copies of this logic would drift, so
 * there is one, used by both.
 */
export function deriveHashtags({ caption, description, customization }) {
    const captionHashtags = extractHashtags(caption || '');
    const descriptionHashtags = extractHashtags(description || '');

    const c = customization || {};
    const explicitTags = [
        ...(c.normal?.tags || []),
        ...(c.product?.tags || []),
        ...(c.service?.tags || []),
        ...(c.business?.tags || []),
    ]
        .map(tag => String(tag).replace(/^#+/, '').trim().toLowerCase())
        .filter(Boolean);

    return [...new Set([...captionHashtags, ...descriptionHashtags, ...explicitTags])];
}

PostSchema.pre('save', function (next) {
    this.hashtags = deriveHashtags({
        caption: this.caption,
        description: this.description,
        customization: this.customization,
    });
    next();
});

/**
 * 🗂 Indexes
 *
 * This collection had none, so every read on the two screens the app opens with
 * was a full collection scan followed by a blocking in-memory sort. Each entry
 * below matches a query the controllers actually run; the sort key is the last
 * field so the index can supply the ordering instead of Mongo sorting the whole
 * result in memory.
 */

// Profile grid / getMyPosts / countDocuments — Post.find({ userId }).sort({ createdAt: -1 })
// (post/read.controllers.js:219,225 and the searchAllContent per-user counts).
PostSchema.index({ userId: 1, createdAt: -1 });

// Profile tabs — switch.controllers.js filters { userId, postType, status } and
// getMyPosts adds ?postType=, both sorted by createdAt desc.
PostSchema.index({ userId: 1, postType: 1, createdAt: -1 });

// Business profile posts ({ userId, contentType: 'business' }, business/profile.js:617)
// and the online store ({ userId: STORE_USER_ID, contentType: 'product' },
// onlineStoreProducts.controllers.js:94).
PostSchema.index({ userId: 1, contentType: 1, createdAt: -1 });

// Home feed and explore both filter userId with a large $in / $nin and sort by
// createdAt desc; this lets those walk the index in order rather than sorting
// the whole matched set.
PostSchema.index({ createdAt: -1 });

// Vibes / reels scroller — matchCriteria carries postType: { $in: ['reel','video'] }
// (reel.controllers.js:110-247) and explore filters postType when asked.
PostSchema.index({ postType: 1, createdAt: -1 });

// Explore's contentType filter (explore.controllers.js:38-45) and the home feed's
// contentType $in, both newest-first.
PostSchema.index({ contentType: 1, createdAt: -1 });

// getTrendingPosts (post/read.controllers.js:563) sorts the whole collection by
// engagement before taking 100.
PostSchema.index({ 'engagement.likes': -1, 'engagement.comments': -1, createdAt: -1 });

// Phase 2: collab profile grids ({ 'collaborators.userId', status }), the
// subcategory filter (#17) and hashtag pages / trending topics (#58).
PostSchema.index({ 'collaborators.userId': 1, createdAt: -1 }, { sparse: true });
PostSchema.index({ subcategories: 1, createdAt: -1 }, { sparse: true });
PostSchema.index({ hashtags: 1, createdAt: -1 });

// Phase 5: the page of a sound lists the posts that use it; duets of a video.
PostSchema.index({ 'music.soundId': 1, createdAt: -1 }, { sparse: true });
PostSchema.index({ 'duet.postId': 1, createdAt: -1 }, { sparse: true });

export default mongoose.model('Post', PostSchema);
