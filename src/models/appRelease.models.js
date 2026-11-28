import mongoose from 'mongoose';

/**
 * An app version that has been announced to users as "available to update to".
 *
 * A row is written when an admin announces a version (Admin > Settings > App
 * update). The newest row per platform is what GET /meta/app-version answers
 * with, which is how the app knows to show its own "Update available" notice,
 * and it is the record of which push went out, to how many phones, and when.
 */
const AppReleaseSchema = new mongoose.Schema({
    platform: { type: String, enum: ['android', 'ios'], default: 'android', index: true },
    // The version name people see, e.g. "4.9.33".
    version: { type: String, required: true, trim: true, maxlength: 20 },
    // One short line shown in the notification and in the app's notice.
    notes: { type: String, default: '', trim: true, maxlength: 200 },
    // How many phones the push was sent to. 0 when the version was saved
    // without notifying anyone.
    pushSent: { type: Number, default: 0 },
    announcedAt: { type: Date, default: Date.now },
    announcedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
}, { timestamps: true });

AppReleaseSchema.index({ platform: 1, announcedAt: -1 });

export default mongoose.model('AppRelease', AppReleaseSchema);
