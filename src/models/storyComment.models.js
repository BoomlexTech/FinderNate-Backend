import mongoose from 'mongoose';

/**
 * A comment on a story (Phase 2 #32).
 *
 * Visible to the story's owner and to the person who wrote it, nobody else
 * (plan Q6). Deleted with the story.
 */
const StoryCommentSchema = new mongoose.Schema({
    storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story', required: true },
    storyOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true, maxlength: 500 }
}, { timestamps: true });

StoryCommentSchema.index({ storyId: 1, createdAt: -1 });
StoryCommentSchema.index({ storyId: 1, userId: 1 });

export default mongoose.model('StoryComment', StoryCommentSchema);
