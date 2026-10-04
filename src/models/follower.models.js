import mongoose from 'mongoose';

const FollowerSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    followerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    }
}, { timestamps: true });

// 🚫 Prevent duplicate follower pairs
FollowerSchema.index({ userId: 1, followerId: 1 }, { unique: true });

// Business Insights: new followers within a date window.
FollowerSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('Follower', FollowerSchema);
