import { StreamClient } from '@stream-io/node-sdk';

class StreamService {
    constructor() {
        this.client = null;
        this.apiKey = null;
        this.apiSecret = null;
        this.initialized = false;
    }

    initialize() {
        try {
            this.apiKey = process.env.STREAM_API_KEY;
            this.apiSecret = process.env.STREAM_API_SECRET;

            if (!this.apiKey || !this.apiSecret) {
                console.warn('⚠️  Stream.io credentials not configured. Set STREAM_API_KEY and STREAM_API_SECRET in .env');
                return false;
            }

            // Initialize Stream client
            this.client = new StreamClient(this.apiKey, this.apiSecret);
            this.initialized = true;


            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Stream.io service:', error.message);
            this.initialized = false;
            return false;
        }
    }

    isConfigured() {
        return this.initialized && this.client !== null;
    }

    getApiKey() {
        return this.apiKey;
    }

    /**
     * Generate a user token for Stream.io Video/Audio calls
     * @param {string} userId - User ID to generate token for
     * @param {number} expirationSeconds - Token expiration time in seconds (default: 24 hours)
     * @returns {Object} { token: string, expiresAt: Date }
     */
    generateUserToken(userId, expirationSeconds = 86400) {
        if (!this.isConfigured()) {
            throw new Error('Stream.io service not configured. Check your environment variables.');
        }

        try {
            // Calculate expiration time
            const expiresAt = new Date(Date.now() + (expirationSeconds * 1000));

            // Generate token using Stream SDK
            const token = this.client.createToken(userId, Math.floor(expiresAt.getTime() / 1000));


            return {
                token,
                expiresAt,
                userId,
                apiKey: this.apiKey
            };
        } catch (error) {
            console.error('❌ Error generating Stream.io token:', error);
            throw new Error(`Failed to generate Stream.io token: ${error.message}`);
        }
    }

    /**
     * Generate a call token with specific permissions
     * @param {string} userId - User ID
     * @param {string} callId - Call ID
     * @param {Array} permissions - Array of permission strings
     * @returns {Object} { token: string, expiresAt: Date }
     */
    generateCallToken(userId, callId, permissions = [], expirationSeconds = 86400) {
        if (!this.isConfigured()) {
            throw new Error('Stream.io service not configured. Check your environment variables.');
        }

        try {
            const expiresAt = new Date(Date.now() + (expirationSeconds * 1000));

            // For call-specific tokens with permissions
            const token = this.client.createToken(
                userId,
                Math.floor(expiresAt.getTime() / 1000),
                {
                    call_cids: [`default:${callId}`],
                    ...(permissions.length > 0 && { permissions })
                }
            );


            return {
                token,
                expiresAt,
                userId,
                callId,
                apiKey: this.apiKey
            };
        } catch (error) {
            console.error('❌ Error generating Stream.io call token:', error);
            throw new Error(`Failed to generate Stream.io call token: ${error.message}`);
        }
    }

    /**
     * Create or update users in Stream.io
     * @param {Array} users - Array of user objects with id, name, image
     * @returns {Object} Upsert response
     */
    async upsertUsers(users) {
        if (!this.isConfigured()) {
            throw new Error('Stream.io service not configured. Check your environment variables.');
        }

        try {
            // Convert users array to the format Stream.io SDK expects (array of user objects)
            // Keep data minimal to stay under 5KB limit per user
            const formattedUsers = users.map(user => {
                const userData = {
                    id: user.id
                };

                // Only add name if provided
                if (user.name) {
                    userData.name = String(user.name).substring(0, 100); // Limit name length
                }

                // Only add image if it's a valid URL (not base64) and reasonable size
                const imageUrl = user.image || user.avatar || user.profilePicture;
                if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http') && imageUrl.length < 500) {
                    userData.image = imageUrl;
                }

                return userData;
            });

            const response = await this.client.upsertUsers(formattedUsers);


            return response;
        } catch (error) {
            console.error('❌ Error upserting Stream.io users:', error);
            throw new Error(`Failed to upsert Stream.io users: ${error.message}`);
        }
    }

    /**
     * Create a call in Stream.io
     * @param {string} callType - Type of call (e.g., 'default', 'audio_room', 'livestream')
     * @param {string} callId - Unique call identifier
     * @param {string} createdBy - User ID who created the call
     * @param {Array} members - Members to add to the call
     * @param {boolean} videoEnabled - Whether video should be enabled initially (default: false)
     * @returns {Object} Call details
     */
    async createCall(callType, callId, createdBy, members = [], videoEnabled = false) {
        if (!this.isConfigured()) {
            throw new Error('Stream.io service not configured. Check your environment variables.');
        }

        try {
            const call = this.client.video.call(callType, callId);

            // Prepare call data with audio/video settings
            const callData = {
                created_by_id: createdBy,
                members: members.map(userId => ({ user_id: userId }))
            };

            // Configure settings based on call type
            if (videoEnabled) {
                // Video call: Enable both audio and video
                callData.settings_override = {
                    audio: {
                        mic_default_on: true,
                        speaker_default_on: true,
                        default_device: 'speaker'
                    },
                    video: {
                        camera_default_on: true,
                        enabled: true,
                        camera_facing: 'front', // Set front camera as default for mobile
                        target_resolution: {
                            width: 1280,
                            height: 720,
                            bitrate: 1500000
                        }
                    },
                    ring: {
                        auto_cancel_timeout_ms: 30000,
                        incoming_call_timeout_ms: 30000
                    },
                    screensharing: {
                        enabled: true,
                        access_request_enabled: false
                    },
                    broadcasting: {
                        enabled: false
                    }
                };
            } else {
                // Voice call: Audio only, explicitly disable video
                callData.settings_override = {
                    audio: {
                        mic_default_on: true,
                        speaker_default_on: true,
                        default_device: 'earpiece'
                    },
                    video: {
                        camera_default_on: false,
                        enabled: false,
                        camera_facing: 'front',
                        target_resolution: {
                            width: 640,
                            height: 480,
                            bitrate: 800000
                        }
                    },
                    ring: {
                        auto_cancel_timeout_ms: 30000,
                        incoming_call_timeout_ms: 30000
                    },
                    screensharing: {
                        enabled: false,
                        access_request_enabled: false
                    },
                    broadcasting: {
                        enabled: false
                    }
                };
            }

            const response = await call.getOrCreate({
                data: callData
            });


            return response;
        } catch (error) {
            console.error('❌ Error creating Stream.io call:', error);
            throw new Error(`Failed to create Stream.io call: ${error.message}`);
        }
    }

    /**
     * End a call in Stream.io
     * @param {string} callType - Type of call
     * @param {string} callId - Call identifier
     * @returns {Object} End call response
     */
    async endCall(callType, callId) {
        if (!this.isConfigured()) {
            throw new Error('Stream.io service not configured. Check your environment variables.');
        }

        try {
            const call = this.client.video.call(callType, callId);
            const response = await call.end();


            return response;
        } catch (error) {
            console.error('❌ Error ending Stream.io call:', error);
            throw new Error(`Failed to end Stream.io call: ${error.message}`);
        }
    }

    /**
     * Who is in a call's media room right now.
     *
     * Used to tell a call that is really going on from one the database still
     * lists as open because neither side ever told us it ended (see
     * utils/callLiveness.rules.js). Never throws: `{ known: false }` means the
     * question could not be answered and the caller must not guess.
     *
     * @returns {Promise<{known: boolean, ended?: boolean, participants?: number, endedAt?: Date|null}>}
     */
    async getCallRoomState(callType, callId) {
        if (!this.isConfigured()) return { known: false };
        try {
            const response = await this.client.video.call(callType, String(callId)).get();
            const call = response?.call;
            if (!call) return { known: false };
            const session = call.session;
            const endedAt = call.ended_at || session?.ended_at || null;
            return {
                known: true,
                ended: !!endedAt,
                participants: Array.isArray(session?.participants) ? session.participants.length : 0,
                endedAt: endedAt ? new Date(endedAt) : null,
            };
        } catch (error) {
            // No such room: nobody can be in it.
            const notFound = error?.metadata?.responseCode === 404 || error?.code === 16 ||
                /not found|does(n't| not) exist/i.test(String(error?.message || ''));
            if (notFound) return { known: true, ended: true, participants: 0, endedAt: null };
            console.warn('⚠️ Could not read the Stream.io room state:', error?.message);
            return { known: false };
        }
    }
}

// Create singleton instance
const streamService = new StreamService();

// Initialize on startup
streamService.initialize();

export default streamService;
