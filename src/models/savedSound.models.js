import mongoose from 'mongoose';

/** A sound someone saved to use later (Phase 5 #29). */
const SavedSoundSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    soundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sound', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

SavedSoundSchema.index({ userId: 1, soundId: 1 }, { unique: true });
SavedSoundSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('SavedSound', SavedSoundSchema);
