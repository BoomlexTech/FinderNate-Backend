import Call from '../models/call.models.js';
import { getPushTargets, sendFcmToTargets } from '../services/pushTargets.service.js';
import Chat from '../models/chat.models.js';
import Message from '../models/message.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import socketManager from '../config/socket.js';
import mongoose from 'mongoose';
import { isBlockedBetween } from '../middlewares/blocking.middleware.js';

// Constants for call management
const CALL_TIMEOUT_MINUTES = 2; // Calls timeout after 2 minutes if not answered
const CLEANUP_INTERVAL_MINUTES = 5; // Run cleanup every 5 minutes

// Helper function to safely emit socket events
const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for user ${userId}`);
    }
};

// Helper function to validate ObjectId
const isValidObjectId = (id) => {
    return mongoose.Types.ObjectId.isValid(id);
};

/**
 * Tear down the Stream.io room for a call.
 *
 * The room is created on initiate and outlives the Call document: marking the
 * call ended/declined/missed in Mongo only changes our record, so without this
 * both parties' already-issued tokens keep working against a live room and
 * Stream keeps billing for anyone who stays in it.
 *
 * Never throws and is not awaited by the request path — a Stream outage must
 * not stop us recording that the call ended, and the room type is always
 * 'default' (see createCall in the initiate/accept paths).
 */
const endStreamRoom = async (callId) => {
    try {
        const streamService = (await import('../config/stream.config.js')).default;
        if (!streamService.isConfigured()) return;
        await streamService.endCall('default', callId.toString());
    } catch (streamError) {
        console.warn('⚠️ Failed to end Stream.io room (non-critical):', streamError.message);
    }
};

// Helper function to cleanup stale calls
const cleanupStaleCalls = async () => {
    try {
        const timeoutDate = new Date(Date.now() - (CALL_TIMEOUT_MINUTES * 60 * 1000));

        // Find calls that are stuck in initiated/ringing state beyond timeout
        const staleCalls = await Call.find({
            status: { $in: ['initiated', 'ringing'] },
            initiatedAt: { $lt: timeoutDate }
        });

        for (const call of staleCalls) {

            // Update call status
            call.status = 'missed';
            call.endedAt = new Date();
            call.endReason = 'timeout';
            await call.save();

            // Close the Stream.io room too - the DB status alone leaves it live
            endStreamRoom(call._id);

            // Notify participants
            const participantIds = call.participants.map(p => p.toString());
            participantIds.forEach(participantId => {
                safeEmitToUser(participantId, 'call_timeout', {
                    callId: call._id,
                    timestamp: new Date()
                });
            });
        }

        if (staleCalls.length > 0) {
        }
    } catch (error) {
        console.error('❌ Error during call cleanup:', error);
    }
};

// Start cleanup interval
setInterval(cleanupStaleCalls, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

// Helper function to check if user has active call
const hasActiveCall = async (userId, session = null) => {
    const query = {
        participants: userId,
        status: { $in: ['initiated', 'ringing', 'connecting', 'active'] }
    };

    const baseQuery = session ?
        Call.findOne(query).session(session) :
        Call.findOne(query);

    return baseQuery.populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');
};

// Helper function to validate chat permissions
const validateChatPermissions = async (chatId, currentUserId, receiverId) => {
    const chat = await Chat.findById(chatId);
    if (!chat) {
        throw new ApiError(404, 'Chat not found');
    }

    const participantIds = chat.participants.map(p => p.toString());
    if (!participantIds.includes(currentUserId.toString()) || !participantIds.includes(receiverId)) {
        throw new ApiError(403, 'You can only call users in your chats');
    }

    return chat;
};

// Initiate a call
export const initiateCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { receiverId, chatId, callType } = req.body;


    // Validate input
    if (!receiverId || !chatId || !callType) {
        console.error('❌ Missing required fields:', { receiverId: !!receiverId, chatId: !!chatId, callType: !!callType });
        throw new ApiError(400, 'Receiver ID, chat ID, and call type are required');
    }

    if (!['voice', 'video'].includes(callType)) {
        console.error('❌ Invalid call type:', callType);
        throw new ApiError(400, 'Call type must be voice or video');
    }

    try {
        // Validate chat permissions and fetch receiver in parallel (optimize)
        const [chat, receiver, isBlocked] = await Promise.all([
            validateChatPermissions(chatId, currentUserId, receiverId),
            User.findById(receiverId).lean(), // Use lean() for faster query
            isBlockedBetween(currentUserId, receiverId)
        ]);

        if (!receiver) {
            console.error('❌ Receiver not found:', receiverId);
            throw new ApiError(404, 'Receiver not found');
        }

        // Blocking has to cover calling as well as messaging. The chat document
        // survives a block, so chat membership alone let a blocked user keep
        // ringing their victim's phone (FCM + full-screen incoming call UI).
        if (isBlocked) {
            console.warn('⚠️ Call blocked between users:', { currentUserId: currentUserId.toString(), receiverId });
            throw new ApiError(403, 'You cannot call this user');
        }

        // Check if user is trying to call themselves
        if (currentUserId.toString() === receiverId) {
            console.error('❌ User trying to call themselves');
            throw new ApiError(400, 'Cannot call yourself');
        }

        // Use transaction to prevent race conditions
        const session = await mongoose.startSession();
        let newCall;

        try {
            await session.withTransaction(async () => {
                // Check if there's already an active call for either user within transaction
                const currentUserActiveCall = await hasActiveCall(currentUserId, session);
                const receiverActiveCall = await hasActiveCall(receiverId, session);

                if (currentUserActiveCall || receiverActiveCall) {
                    const existingCall = currentUserActiveCall || receiverActiveCall;
                    const busyUser = currentUserActiveCall ? 'You are' : 'The recipient is';
                    console.warn('⚠️ User already in call:', { existingCallId: existingCall._id, busyUser });

                    // Create enhanced error with call details
                    const error = new ApiError(409, `${busyUser} already in a call`);
                    error.data = {
                        existingCallId: existingCall._id,
                        existingCall: {
                            _id: existingCall._id,
                            status: existingCall.status,
                            callType: existingCall.callType,
                            initiatedAt: existingCall.initiatedAt,
                            participants: existingCall.participants
                        }
                    };
                    throw error;
                }

                // Create new call record within transaction
                newCall = new Call({
                    participants: [currentUserId, receiverId],
                    initiator: currentUserId,
                    chatId,
                    callType,
                    status: 'initiated'
                });

                await newCall.save({ session });
            });
        } finally {
            await session.endSession();
        }

        // Update call status to 'ringing' when receiver is being notified
        // This indicates the call is actively ringing for the receiver
        try {
            await Call.findByIdAndUpdate(newCall._id, { status: 'ringing' });
        } catch (statusError) {
            console.error('❌ Error updating call status to ringing:', statusError);
            // Don't fail the entire call initiation if status update fails
        }

        // Populate the call with user details (optimized with lean)
        const populatedCall = await Call.findById(newCall._id)
            .populate('participants', 'username fullName profileImageUrl')
            .populate('initiator', 'username fullName profileImageUrl')
            .lean();

        // Create Stream.io call and generate tokens for both participants (BEFORE notifications)
        // streamData is what the CALLER receives; the receiver's token is kept
        // separate and only ever travels on the receiver's own socket event.
        let streamData = null;
        let receiverStreamToken = null;
        try {
            const streamService = (await import('../config/stream.config.js')).default;

            if (streamService.isConfigured()) {

                // Register users in Stream.io
                await streamService.upsertUsers([
                    {
                        id: currentUserId.toString(),
                        name: req.user.fullName || req.user.username || 'User',
                        image: req.user.profileImageUrl || undefined
                    },
                    {
                        id: receiver._id.toString(),
                        name: receiver.fullName || receiver.username || 'User',
                        image: receiver.profileImageUrl || undefined
                    }
                ]);

                // Create Stream.io call - use 'default' type for both voice and video
                // The difference is in the videoEnabled setting
                const streamCallType = 'default';
                const videoEnabled = callType === 'video';
                const callResponse = await streamService.createCall(
                    streamCallType,
                    newCall._id.toString(),
                    currentUserId.toString(),
                    [currentUserId.toString(), receiver._id.toString()],
                    videoEnabled
                );

                // Generate tokens for both users
                const callerToken = streamService.generateUserToken(currentUserId.toString());
                const receiverToken = streamService.generateUserToken(receiver._id.toString());

                // The receiver's token is a 24h Stream identity token for THEIR
                // user id and cannot be revoked once minted - it must never be
                // returned to the caller, only pushed to the receiver below.
                receiverStreamToken = receiverToken.token;

                streamData = {
                    apiKey: streamService.getApiKey(),
                    callId: newCall._id.toString(),
                    streamCallType,
                    callerToken: callerToken.token,
                    expiresAt: callerToken.expiresAt
                };

            } else {
                console.warn('⚠️ Stream.io not configured - calls will not work properly');
            }
        } catch (streamError) {
            console.error('❌ Stream.io call creation error:', streamError);
            // Don't fail the entire call if Stream.io fails - log and continue
        }

        // Send FCM push notification to receiver (fire-and-forget, non-blocking)

        // Ring every device the receiver is signed in on, including phones
        // that hold several accounts (Phase 3 #25). Fire and forget.
        (async () => {
            const targets = await getPushTargets([receiverId]);
            if (!targets.length) return;
            await sendFcmToTargets(targets, {
                title: `Incoming ${callType} call`,
                body: `${req.user.fullName || req.user.username} is calling you...`,
                type: 'incoming_call',
                data: {
                    callId: newCall._id.toString(),
                    callerId: currentUserId.toString(),
                    callerName: req.user.fullName || req.user.username,
                    callerImage: req.user.profileImageUrl || '',
                    chatId: chatId.toString(),
                    callType: callType,
                    status: 'ringing' // Include status so receiver knows call is ringing
                }
            });
        })().catch(err => console.error('Incoming call push failed:', err?.message || err));

        // Emit call initiation via socket (as backup or if FCM failed)
        if (socketManager.isReady()) {
            const callData = {
                callId: newCall._id,
                chatId,
                callType,
                status: 'ringing', // Include status so receiver knows call is ringing
                caller: {
                    _id: currentUserId,
                    username: req.user.username,
                    fullName: req.user.fullName,
                    profileImageUrl: req.user.profileImageUrl
                },
                stream: streamData ? {
                    apiKey: streamData.apiKey,
                    token: receiverStreamToken,
                    callId: streamData.callId,
                    streamCallType: streamData.streamCallType
                } : null,
                timestamp: new Date()
            };


            // Ensure receiverId is string
            const receiverIdStr = receiverId.toString();
            socketManager.emitToUser(receiverIdStr, 'incoming_call', callData);
        } else {
            console.error('❌ Socket manager not ready - cannot emit incoming_call event; relying on the push');
        }

        // Create a call message in the chat (non-blocking, fire-and-forget)
        (async () => {
            try {
                const callMessage = new Message({
                    chatId,
                    sender: currentUserId,
                    message: `${callType} call ${callType === 'voice' ? '📞' : '📹'}`,
                    messageType: 'call'
                });
                await callMessage.save();
            } catch (messageError) {
                console.warn('⚠️ Failed to create call message (non-critical):', messageError.message);
            }
        })();

        res.status(201).json(
            new ApiResponse(201, {
                ...populatedCall,
                stream: streamData
            }, 'Call initiated successfully')
        );

    } catch (error) {
        console.error('❌ Error in initiateCall:', {
            message: error.message,
            stack: error.stack,
            data: error.data
        });

        // Re-throw the error to be handled by asyncHandler
        throw error;
    }
});

// Accept a call
export const acceptCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;


    // Validate call ID format
    if (!isValidObjectId(callId)) {
        console.error('❌ Invalid call ID format:', callId);
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Update call status with transaction - fetch and update in same transaction
    const session = await mongoose.startSession();
    let updatedCall;

    try {
        await session.withTransaction(async () => {
            // Fetch call within transaction for atomic operation
            const call = await Call.findById(callId).session(session);

            if (!call) {
                console.error('❌ Call not found:', callId);
                throw new ApiError(404, 'Call not found');
            }

            // Check if user is a participant
            const participantIds = call.participants.map(p => p.toString());
            if (!participantIds.includes(currentUserId.toString())) {
                console.error('❌ User not a participant:', { currentUserId, participants: participantIds });
                throw new ApiError(403, 'You are not a participant in this call');
            }

            // Check if call is in the right status
            if (!['initiated', 'ringing', 'connecting'].includes(call.status)) {
                console.error('❌ Invalid call status for acceptance:', {
                    currentStatus: call.status,
                    allowedStatuses: ['initiated', 'ringing', 'connecting']
                });

                // Provide more detailed error message
                const statusMessages = {
                    'ended': 'The call has already ended',
                    'declined': 'The call was declined',
                    'missed': 'The call was missed',
                    'active': 'The call is already active'
                };
                const errorMessage = statusMessages[call.status] || `Call cannot be accepted in current status: ${call.status}`;
                throw new ApiError(400, errorMessage);
            }

            // Idempotent behavior: If already connecting, just return the current call data
            if (call.status === 'connecting' && call.startedAt) {
                console.warn('⚠️ Call already in connecting state (idempotent request)');
                updatedCall = call;
                return; // Exit transaction early, proceed to response
            }

            // Update call status
            call.status = 'connecting';
            call.startedAt = new Date();
            await call.save({ session });

            updatedCall = call;
        });
    } catch (error) {
        console.error('❌ Transaction failed:', error);
        throw error;
    } finally {
        await session.endSession();
    }

    // Fetch populated call data after transaction
    const populatedCall = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');

    // Get Stream.io connection details for the receiver (needed to connect to media)
    let streamData = null;
    try {
        const streamService = (await import('../config/stream.config.js')).default;
        if (streamService.isConfigured()) {
            // Generate fresh token for receiver
            const receiverToken = streamService.generateUserToken(currentUserId.toString());
            streamData = {
                apiKey: streamService.getApiKey(),
                callId: callId.toString(),
                streamCallType: 'default',
                token: receiverToken.token,
                expiresAt: receiverToken.expiresAt
            };
        }
    } catch (streamError) {
        console.error('❌ Error generating Stream.io token for receiver:', streamError);
        // Continue without Stream.io data - client should use stored token from incoming_call
    }

    // Emit call acceptance to ALL participants (including the one who accepted for immediate UI update)
    const participantIds = populatedCall.participants.map(p => p._id.toString());
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());

    const callAcceptedData = {
        callId,
        acceptedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName,
            profileImageUrl: req.user.profileImageUrl
        },
        call: {
            _id: populatedCall._id,
            status: populatedCall.status,
            callType: populatedCall.callType,
            startedAt: populatedCall.startedAt,
            participants: populatedCall.participants,
            initiator: populatedCall.initiator
        }, // Include essential call data for immediate UI update
        timestamp: new Date()
    };

    // CRITICAL FIX: Emit to receiver FIRST with Stream.io connection details (prevents loading state)
    // This ensures the phone app gets immediate feedback and can connect to Stream.io
    safeEmitToUser(currentUserId.toString(), 'call_accepted', {
        ...callAcceptedData,
        isReceiver: true, // Flag to indicate this is confirmation for the receiver
        stream: streamData, // Include Stream.io connection details to prevent loading state
        action: 'connect' // Action flag to tell phone app to connect to Stream.io
    });

    // Then emit to other participants (caller)
    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_accepted', callAcceptedData);
    });


    // Include Stream.io connection details in HTTP response as fallback
    // This ensures phone app has connection details even if socket event is missed
    const responseData = {
        ...populatedCall.toObject ? populatedCall.toObject() : populatedCall,
        stream: streamData // Include Stream.io connection details
    };

    res.status(200).json(
        new ApiResponse(200, responseData, 'Call accepted successfully')
    );
});

// Decline a call
export const declineCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;


    // Validate call ID format
    if (!isValidObjectId(callId)) {
        console.error('❌ Invalid call ID format:', callId);
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Update call status with transaction - fetch and update in same transaction
    const session = await mongoose.startSession();
    let updatedCall;

    try {
        await session.withTransaction(async () => {
            // Fetch call within transaction for atomic operation
            const call = await Call.findById(callId).session(session);

            if (!call) {
                console.error('❌ Call not found:', callId);
                throw new ApiError(404, 'Call not found');
            }

            // Check if user is a participant
            const participantIds = call.participants.map(p => p.toString());
            if (!participantIds.includes(currentUserId.toString())) {
                console.error('❌ User not a participant:', { currentUserId, participants: participantIds });
                throw new ApiError(403, 'You are not a participant in this call');
            }

            // Check if call can be declined
            if (!['initiated', 'ringing'].includes(call.status)) {
                console.error('❌ Invalid call status for decline:', {
                    currentStatus: call.status,
                    allowedStatuses: ['initiated', 'ringing']
                });
                throw new ApiError(400, `Call cannot be declined in current status: ${call.status}`);
            }

            // Update call status
            call.status = 'declined';
            call.endedAt = new Date();
            call.endReason = 'declined';

            await call.save({ session });
            updatedCall = call;
        });
    } catch (error) {
        console.error('❌ Transaction failed:', error);
        throw error;
    } finally {
        await session.endSession();
    }

    // The room was created on initiate - close it, or the caller's token keeps
    // working against a live Stream room after the call was refused.
    endStreamRoom(callId);

    // Fetch populated call data after transaction
    const populatedCall = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');

    // Emit call decline to other participants
    const participantIds = populatedCall.participants.map(p => p._id.toString());
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());

    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_declined', {
            callId,
            declinedBy: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            timestamp: new Date()
        });
    });

    res.status(200).json(
        new ApiResponse(200, populatedCall, 'Call declined successfully')
    );
});

// End a call
export const endCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { endReason = 'normal' } = req.body;


    // Validate call ID format
    if (!isValidObjectId(callId)) {
        console.error('❌ Invalid call ID format:', callId);
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Validate endReason
    const validReasons = ['normal', 'declined', 'missed', 'failed', 'network_error', 'cancelled', 'timeout'];
    if (!validReasons.includes(endReason)) {
        console.error('❌ Invalid end reason:', endReason);
        throw new ApiError(400, `Invalid end reason. Must be one of: ${validReasons.join(', ')}`);
    }

    // Update call status with transaction - fetch and update in same transaction
    const session = await mongoose.startSession();
    let updatedCall;

    try {
        await session.withTransaction(async () => {
            // Fetch call within transaction for atomic operation
            const call = await Call.findById(callId).session(session);

            if (!call) {
                console.error('❌ Call not found:', callId);
                throw new ApiError(404, 'Call not found');
            }

            // Check if user is a participant
            const participantIds = call.participants.map(p => p.toString());
            if (!participantIds.includes(currentUserId.toString())) {
                console.error('❌ User not a participant:', { currentUserId, participants: participantIds });
                throw new ApiError(403, 'You are not a participant in this call');
            }

            // Check if call is already in a terminal state (idempotent behavior)
            if (call.status === 'ended' || call.status === 'declined' || call.status === 'missed') {
                console.warn('⚠️  Call already finished (idempotent request):', {
                    currentStatus: call.status,
                    endedAt: call.endedAt,
                    requestedEndReason: endReason
                });
                // Don't throw error - return existing call data (idempotent behavior)
                updatedCall = call;
                return; // Exit transaction early, proceed to response
            }

            // A call that was never answered (no startedAt - it was hung up or
            // cancelled while still ringing) is a MISSED call, not a completed
            // one. It used to be stored as 'ended' with startedAt back-filled to
            // endedAt, which made wasAnswered true and counted it in
            // answeredCalls (call.models.js) - so the receiver never saw a
            // missed call and the stats showed calls nobody picked up as
            // answered. Duration stays 0 because the pre-save hook needs both
            // timestamps, which is correct for a call that never connected.
            const wasAnswered = !!call.startedAt;

            // Update call status
            call.status = wasAnswered ? 'ended' : 'missed';
            call.endedAt = new Date();
            call.endReason = endReason;
            call.endedBy = currentUserId; // Track who ended the call

            await call.save({ session });
            updatedCall = call;
        });
    } catch (error) {
        console.error('❌ Transaction failed:', error);
        throw error;
    } finally {
        await session.endSession();
    }

    // End the media room as well - without this the DB says the call is over
    // while the Stream room stays live and both parties' tokens still join it.
    endStreamRoom(callId);

    // Fetch populated call data after transaction
    const populatedCall = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');

    if (!populatedCall) {
        console.error('❌ Call not found after transaction:', callId);
        throw new ApiError(404, 'Call not found');
    }

    // Extract participant IDs - handle both populated objects and ObjectIds
    // Also use the non-populated call's participants as fallback to ensure we get all participants
    let participantIds = [];

    if (populatedCall.participants && populatedCall.participants.length > 0) {
        participantIds = populatedCall.participants.map(p => {
            // Handle populated user object
            if (p && p._id) {
                return p._id.toString();
            }
            // Handle ObjectId directly
            if (p && p.toString) {
                return p.toString();
            }
            return null;
        }).filter(id => id !== null);
    }

    // Fallback: if population failed or returned empty, use the updated call's participants
    if (participantIds.length === 0 && updatedCall && updatedCall.participants) {
        console.warn('⚠️ Using fallback: extracting participants from non-populated call');
        participantIds = updatedCall.participants.map(p => p.toString());
    }

    // Get other participants (excluding the one who ended the call)
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());

    const callEndedData = {
        callId,
        endedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName,
            profileImageUrl: req.user.profileImageUrl
        },
        endReason,
        duration: populatedCall.duration,
        call: {
            _id: populatedCall._id,
            status: populatedCall.status, // Should be 'ended'
            callType: populatedCall.callType,
            endedAt: populatedCall.endedAt,
            duration: populatedCall.duration,
            endReason: populatedCall.endReason
        }, // Include essential call data for immediate UI update
        action: 'dismiss', // CRITICAL: Action flag to tell phone app to dismiss incoming call UI
        timestamp: new Date()
    };

    // CRITICAL FIX: Emit to ALL participants including the one who ended the call
    // This ensures the phone app gets immediate notification and updates UI
    // Emit synchronously to all participants to ensure immediate delivery
    participantIds.forEach(participantId => {
        safeEmitToUser(participantId, 'call_ended', {
            ...callEndedData,
            isInitiator: participantId === currentUserId.toString(), // Flag to indicate who ended
            shouldDismiss: true // Explicit flag to dismiss incoming call UI on phone app
        });
    });

    // Also emit to other participants specifically (for backwards compatibility)
    if (otherParticipants.length > 0) {
    } else {
        console.warn('⚠️ No other participants found to notify about call end');
    }

    res.status(200).json(
        new ApiResponse(200, populatedCall, 'Call ended successfully')
    );
});

// Update call status (for Agora connection state tracking only)
export const updateCallStatus = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { callId } = req.params;
    const { status, metadata } = req.body;


    // Validate call ID format
    if (!isValidObjectId(callId)) {
        console.error('❌ Invalid call ID format:', callId);
        throw new ApiError(400, 'Invalid call ID format');
    }

    // Validate status - ONLY allow connection state updates, NOT terminal states
    // Terminal states (ended/declined/missed/failed) must use dedicated endpoints
    const validStatuses = ['connecting', 'active'];
    if (!validStatuses.includes(status)) {
        console.error('❌ Invalid status for updateCallStatus:', {
            providedStatus: status,
            allowedStatuses: validStatuses,
            note: 'Use /decline or /end endpoints for terminal states'
        });
        throw new ApiError(400, `Invalid call status. Use /accept, /decline, or /end endpoints instead. Allowed statuses: ${validStatuses.join(', ')}`);
    }

    // Use transaction for atomic update
    const session = await mongoose.startSession();
    let updatedCall;

    try {
        await session.withTransaction(async () => {
            // Find the call within transaction
            const call = await Call.findById(callId).session(session);

            if (!call) {
                console.error('❌ Call not found:', callId);
                throw new ApiError(404, 'Call not found');
            }

            // Check if user is a participant
            const participantIds = call.participants.map(p => p.toString());
            if (!participantIds.includes(currentUserId.toString())) {
                console.error('❌ User not a participant:', { currentUserId, participants: participantIds });
                throw new ApiError(403, 'You are not a participant in this call');
            }

            // Check if call is still active (not ended/declined/missed/failed)
            if (['ended', 'declined', 'missed', 'failed'].includes(call.status)) {
                console.error('❌ Cannot update status of finished call:', {
                    currentStatus: call.status,
                    attemptedStatus: status
                });
                throw new ApiError(400, `Call has already finished with status: ${call.status}. Cannot update to ${status}.`);
            }

            // Update call status
            call.status = status;
            if (metadata) {
                call.metadata = { ...call.metadata, ...metadata };
            }

            // Set startedAt when call becomes active
            if (status === 'active' && !call.startedAt) {
                call.startedAt = new Date();
            }

            await call.save({ session });
            updatedCall = call;
        });
    } catch (error) {
        console.error('❌ Transaction failed:', error);
        throw error;
    } finally {
        await session.endSession();
    }

    // Fetch populated call
    const populatedCall = await Call.findById(callId)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('initiator', 'username fullName profileImageUrl');

    // Emit status update to other participants
    const participantIds = populatedCall.participants.map(p => p._id.toString());
    const otherParticipants = participantIds.filter(id => id !== currentUserId.toString());

    otherParticipants.forEach(participantId => {
        safeEmitToUser(participantId, 'call_status_update', {
            callId,
            status,
            metadata,
            updatedBy: currentUserId,
            timestamp: new Date()
        });
    });

    res.status(200).json(
        new ApiResponse(200, populatedCall, 'Call status updated successfully')
    );
});

// Get call history for user
export const getCallHistory = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { page = 1, limit = 20 } = req.query;

    const calls = await Call.getCallHistory(currentUserId, parseInt(limit), parseInt(page));

    // Calculate pagination info
    const totalCalls = await Call.countDocuments({
        participants: currentUserId,
        status: { $in: ['ended', 'declined', 'missed'] }
    });

    const pagination = {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCalls / parseInt(limit)),
        totalCalls,
        hasNextPage: parseInt(page) < Math.ceil(totalCalls / parseInt(limit)),
        hasPrevPage: parseInt(page) > 1
    };

    res.status(200).json(
        new ApiResponse(200, { calls, pagination }, 'Call history fetched successfully')
    );
});

// Get active call for user
export const getActiveCall = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;

    const activeCall = await Call.getActiveCall(currentUserId);

    res.status(200).json(
        new ApiResponse(200, activeCall, 'Active call fetched successfully')
    );
});

// Get call statistics
export const getCallStats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { days = 30 } = req.query;

    const stats = await Call.getCallStats(currentUserId, parseInt(days));

    res.status(200).json(
        new ApiResponse(200, stats[0] || {}, 'Call statistics fetched successfully')
    );
});

// Force end all active calls for current user (cleanup endpoint)
export const forceEndActiveCalls = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;


    // Find all active calls for this user
    const activeCalls = await Call.find({
        participants: currentUserId,
        status: { $in: ['initiated', 'ringing', 'connecting', 'active'] }
    });

    if (activeCalls.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, { endedCount: 0 }, 'No active calls to end')
        );
    }


    const endedCalls = [];

    for (const call of activeCalls) {
        try {
            // Calculate duration if call was active
            if (call.startedAt && !call.endedAt) {
                call.endedAt = new Date();
                call.duration = Math.floor((call.endedAt - call.startedAt) / 1000);
            } else if (!call.endedAt) {
                call.endedAt = new Date();
            }

            // Update status
            // endReason must stay inside the schema enum (call.models.js) -
            // 'force_cleanup' is not in it, so the save threw a ValidationError
            // that this loop swallowed and the stuck call was never cleared.
            call.status = call.startedAt ? 'ended' : 'missed';
            call.endReason = call.startedAt ? 'normal' : 'cancelled';
            call.endedBy = currentUserId;

            await call.save();

            // Close the media room as well, not just our record of it
            endStreamRoom(call._id);

            // Notify other participants
            const otherParticipants = call.participants
                .filter(p => p.toString() !== currentUserId.toString());

            otherParticipants.forEach(participantId => {
                safeEmitToUser(participantId, 'call_ended', {
                    callId: call._id,
                    endedBy: currentUserId,
                    reason: 'force_cleanup',
                    timestamp: new Date()
                });
            });

            endedCalls.push({
                callId: call._id,
                status: call.status,
                duration: call.duration
            });

        } catch (error) {
            console.error(`❌ Error ending call ${call._id}:`, error);
        }
    }

    res.status(200).json(
        new ApiResponse(200, {
            endedCount: endedCalls.length,
            endedCalls
        }, `Successfully force-ended ${endedCalls.length} call(s)`)
    );
});

