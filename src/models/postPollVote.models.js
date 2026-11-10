import mongoose from 'mongoose';

/**
 * One person's vote on the poll of one post (Phase 6 #72). `choice` is the
 * index of the answer in the post's `poll.options`. A vote cannot be changed or
 * withdrawn, so there is one row per person per post and no update path.
 *
 * The rows go when the post is deleted for good (the Bin purge, an admin
 * removal, closing an account); while a post sits in the Bin they stay, so a
 * restored post keeps its votes.
 */
const PostPollVoteSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    choice: { type: Number, required: true, min: 0, max: 3 },
}, { timestamps: { createdAt: true, updatedAt: false } });

PostPollVoteSchema.index({ postId: 1, userId: 1 }, { unique: true });
PostPollVoteSchema.index({ userId: 1, postId: 1 });

export default mongoose.model('PostPollVote', PostPollVoteSchema);
