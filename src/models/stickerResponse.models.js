import mongoose from 'mongoose';

/**
 * One person's answer to one interactive story sticker (Phase 5 #47): a poll
 * vote, a quiz answer, a slider value, a question asked, or a countdown
 * reminder. One row per person per sticker.
 *
 * Countdown reminders carry what the reminder notification needs, so it can
 * still be sent after the story itself has gone.
 */
const StickerResponseSchema = new mongoose.Schema({
    storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story', required: true },
    storyOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    stickerId: { type: String, required: true },
    stickerType: { type: String, enum: ['poll', 'quiz', 'slider', 'countdown', 'question'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    choice: Number,
    isCorrect: Boolean,
    value: Number,
    text: { type: String, maxlength: 300 },
    // Countdown
    remindAt: { type: Date, default: null },
    remindNotifiedAt: { type: Date, default: null },
    countdownTitle: String,
    // Question: the owner's answer back to this person.
    reply: {
        type: new mongoose.Schema({ text: String, at: Date }, { _id: false }),
        default: undefined,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });

StickerResponseSchema.index({ storyId: 1, stickerId: 1, userId: 1 }, { unique: true });
StickerResponseSchema.index({ storyId: 1, userId: 1 });
StickerResponseSchema.index({ remindAt: 1, remindNotifiedAt: 1 }, { partialFilterExpression: { remindAt: { $type: 'date' } } });

export default mongoose.model('StickerResponse', StickerResponseSchema);
