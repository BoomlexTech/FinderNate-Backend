import express from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { upload } from '../middlewares/multerConfig.js';
import { chatRateLimit } from '../middlewares/rateLimiter.middleware.js';
import {
    createChat,
    getUserChats,
    getChatMessages,
    addMessage,
    markMessagesRead,
    markChatAsRead,
    deleteMessageForEveryone,
    deleteMessageForMe,
    restoreMessage,
    startTyping,
    stopTyping,
    getOnlineStatus,
    searchMessages,
    acceptChatRequest,
    declineChatRequest,
    updateChatTheme,
    updateGroupImage,
    updateGroupName,
    removeGroupMember,
    leaveGroup,
    deleteGroup,
    // Enhanced messaging features
    addReaction,
    removeReaction,
    editMessage,
    forwardMessage,
    togglePinMessage,
    getPinnedMessages,
    muteChat,
    unmuteChat
} from '../controllers/chat/index.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(verifyJWT);

// Apply rate limiting to all chat routes
router.use(chatRateLimit);

// Create a new chat (1-on-1 or group)
router.post('/', createChat);

// Get all chats for a user
router.get('/', getUserChats);

// Chat request management
router.patch('/:chatId/accept', acceptChatRequest);
router.patch('/:chatId/decline', declineChatRequest);

// Update chat theme color
router.patch('/:chatId/theme', updateChatTheme);

// Mute / unmute push notifications for one chat (Phase 2 #38)
router.patch('/:chatId/mute', muteChat);
router.delete('/:chatId/mute', unmuteChat);

// Set, replace or clear a group's image (admins only; multipart 'groupImage')
router.patch('/:chatId/group-image', upload.single('groupImage'), updateGroupImage);

// Rename a group (admins only)
router.patch('/:chatId/group-name', updateGroupName);

// Remove another participant from a group (admins only)
router.delete('/:chatId/members/:memberId', removeGroupMember);

// Leave a group (any participant, including the creator)
router.post('/:chatId/leave', leaveGroup);

// Delete an entire group (admins only) — destroys it for every member
router.delete('/:chatId', deleteGroup);

// Get messages for a chat
router.get('/:chatId/messages', getChatMessages);

// Add a message to a chat (with optional file upload)
router.post('/:chatId/messages', upload.single('mediaFile'), addMessage);

// Alternative route for JSON messages (without file upload)
router.post('/:chatId/messages/text', addMessage);

// Mark messages as read
router.patch('/:chatId/read', markMessagesRead);

// Mark all messages in a chat as read
router.patch('/:chatId/read-all', markChatAsRead);

// Delete a message for everyone (24-hour limit)
router.delete('/:chatId/messages/:messageId', deleteMessageForEveryone);

// Delete a message for me only (no time limit)
router.delete('/:chatId/messages/:messageId/for-me', deleteMessageForMe);

// Restore a deleted message
router.patch('/:chatId/messages/:messageId/restore', restoreMessage);

// ==================== ENHANCED MESSAGING FEATURES ====================

// Message reactions
router.post('/:chatId/messages/:messageId/reactions', addReaction);
router.delete('/:chatId/messages/:messageId/reactions', removeReaction);

// Edit message (within 24 hours)
router.patch('/:chatId/messages/:messageId/edit', editMessage);

// Forward message to other chats
router.post('/:chatId/messages/:messageId/forward', forwardMessage);

// Pin/Unpin messages
router.patch('/:chatId/messages/:messageId/pin', togglePinMessage);
router.get('/:chatId/pinned', getPinnedMessages);

// ==================== END ENHANCED MESSAGING FEATURES ====================

// Typing indicators
router.post('/:chatId/typing/start', startTyping);
router.post('/:chatId/typing/stop', stopTyping);

// Online status
router.get('/users/online-status', getOnlineStatus);

// Search messages in a chat
router.get('/:chatId/search', searchMessages);

export default router; 