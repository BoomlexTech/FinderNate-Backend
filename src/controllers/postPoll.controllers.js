import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';
import PostPollVote from '../models/postPollVote.models.js';
import { assertCanViewPostById, createPostVisibilityChecker } from './post/visibility.js';
import {
    POLL_LIMITS, PollValidationError, pollHasEnded, readPollVote, statsFromGroups, summarizePoll,
} from '../utils/poll.rules.js';

/**
 * Polls on posts (Phase 6 #72). The poll itself is saved with the post (see
 * buildPostExtras); votes live in PostPollVote.
 *
 *   POST /posts/:postId/poll/vote     { choice }      one vote per person, final
 *   GET  /posts/:postId/poll                           the poll as this viewer sees it
 *   POST /posts/polls/batch           { postIds }      many at once, for a feed page
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

/** { postId → [{ choice, n }] } for the given posts, counted by the database. */
const countVotes = async (postIds) => {
    const byPost = new Map();
    if (!postIds.length) return byPost;
    const groups = await PostPollVote.aggregate([
        { $match: { postId: { $in: postIds } } },
        { $group: { _id: { p: '$postId', c: '$choice' }, n: { $sum: 1 } } },
    ]);
    for (const g of groups) {
        const key = String(g._id.p);
        if (!byPost.has(key)) byPost.set(key, []);
        byPost.get(key).push({ choice: g._id.c, n: g.n });
    }
    return byPost;
};

/** The summaries of the polls on `posts` ({ _id, userId, poll }), as `viewerId` sees them. */
const summariesFor = async (posts, viewerId) => {
    const withPoll = posts.filter((p) => p?.poll?.options?.length);
    const ids = withPoll.map((p) => new mongoose.Types.ObjectId(String(p._id)));
    const [counts, mine] = await Promise.all([
        countVotes(ids),
        viewerId && ids.length ? PostPollVote.find({ postId: { $in: ids }, userId: viewerId }).select('postId choice').lean() : [],
    ]);
    const mineByPost = new Map(mine.map((v) => [String(v.postId), v.choice]));
    const out = new Map();
    for (const post of withPoll) {
        const key = String(post._id);
        const isOwner = !!viewerId && String(post.userId?._id ?? post.userId) === String(viewerId);
        out.set(key, summarizePoll(
            post.poll,
            statsFromGroups(post.poll, counts.get(key) || []),
            mineByPost.has(key) ? mineByPost.get(key) : null,
            { isOwner },
        ));
    }
    return out;
};

const loadPollPost = async (postId, viewerId) => {
    const visible = await assertCanViewPostById(postId, viewerId);
    const post = await Post.findById(visible._id).select('userId poll status').lean();
    if (!post?.poll?.options?.length) throw new ApiError(404, 'This post has no poll.');
    return post;
};

/** POST /posts/:postId/poll/vote { choice } */
export const votePoll = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const post = await loadPollPost(req.params.postId, userId);
    if (String(post.userId) === String(userId)) throw new ApiError(403, "You can't vote on your own poll.");
    if (post.status && post.status !== 'published') throw new ApiError(400, 'This poll is not open yet.');
    if (pollHasEnded(post.poll)) throw new ApiError(400, 'This poll has ended.');

    let choice;
    try { choice = readPollVote(post.poll, req.body); } catch (e) {
        throw e instanceof PollValidationError ? new ApiError(400, e.message) : e;
    }

    try {
        await PostPollVote.create({ postId: post._id, userId, choice });
    } catch (e) {
        if (e?.code !== 11000) throw e;
        // The first vote stands.
        const summary = (await summariesFor([post], userId)).get(String(post._id));
        return res.status(409).json(new ApiResponse(409, summary, 'You already voted'));
    }
    const summary = (await summariesFor([post], userId)).get(String(post._id));
    return res.status(200).json(new ApiResponse(200, summary, 'Thanks for voting'));
});

/** GET /posts/:postId/poll */
export const getPoll = asyncHandler(async (req, res) => {
    const viewerId = req.user?._id || null;
    const post = await loadPollPost(req.params.postId, viewerId);
    const summary = (await summariesFor([post], viewerId)).get(String(post._id));
    return res.status(200).json(new ApiResponse(200, summary, 'Poll'));
});

/**
 * POST /posts/polls/batch { postIds: [...] } — up to 30 ids. Posts the viewer
 * may not see, or that have no poll, are left out (not an error), so a client
 * can ask about a whole feed page without knowing which cards carry a poll.
 */
export const getPollsBatch = asyncHandler(async (req, res) => {
    const viewerId = req.user?._id || null;
    const raw = Array.isArray(req.body?.postIds) ? req.body.postIds : [];
    const ids = [...new Set(raw.map(String).filter(isValidId))];
    if (!ids.length) return res.status(200).json(new ApiResponse(200, { polls: {} }, 'Polls'));
    if (ids.length > POLL_LIMITS.maxBatch) throw new ApiError(400, `Ask for up to ${POLL_LIMITS.maxBatch} posts at a time.`);

    const posts = await Post.find({ _id: { $in: ids }, 'poll.endsAt': { $exists: true } })
        .select('userId poll status settings.privacy')
        .lean();
    const canSee = createPostVisibilityChecker(viewerId);
    const visible = [];
    for (const post of posts) {
        if (await canSee(post)) visible.push(post);
    }
    const summaries = await summariesFor(visible, viewerId);
    return res.status(200).json(new ApiResponse(200, { polls: Object.fromEntries(summaries) }, 'Polls'));
});
