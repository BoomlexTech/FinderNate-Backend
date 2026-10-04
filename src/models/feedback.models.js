import mongoose from 'mongoose';
import { FEEDBACK_STATUSES, FEEDBACK_PRIORITIES } from '../utils/supportQueue.utils.js';

const FeedbackSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    category: {
        type: String,
        trim: true,
        maxlength: 40
    },
    submittedAt: {
        type: Date,
        default: Date.now,
        index: true
    },

    status: {
        type: String,
        enum: FEEDBACK_STATUSES,
        default: 'open'
    },

    // The sender's plan when they wrote in, kept so a request stays in the queue
    // position it was promised even if the plan lapses before it is answered.
    planAtSubmit: {
        type: String,
        enum: ['free', 'small_business', 'corporate']
    },
    priority: {
        type: String,
        enum: FEEDBACK_PRIORITIES,
        default: 'standard'
    },
    // Sortable form of `priority`: 0 standard, 1 priority, 2 dedicated.
    priorityRank: {
        type: Number,
        default: 0
    },

    slaDueAt: { type: Date },
    firstResponseAt: { type: Date },
    resolvedAt: { type: Date },

    handledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    },
    adminNote: {
        type: String,
        trim: true,
        maxlength: 500
    }
}, {
    timestamps: true
});

// Index for better query performance
FeedbackSchema.index({ submittedAt: -1 });
// The admin queue: working statuses, highest priority first, oldest first.
FeedbackSchema.index({ status: 1, priorityRank: -1, createdAt: 1 });

const Feedback = mongoose.model('Feedback', FeedbackSchema);
export default Feedback;
