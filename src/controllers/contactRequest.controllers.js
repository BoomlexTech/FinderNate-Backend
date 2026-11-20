import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import ContactRequest from "../models/contactRequest.models.js";
import Business from "../models/business.models.js";
import mongoose from "mongoose";
import {
    createContactRequestNotification,
    createContactResponseNotification
} from "./notification.controllers.js";

// POST /api/v1/contact-requests/:businessId
const sendContactRequest = asyncHandler(async (req, res) => {
    const { businessId } = req.params;
    const { message } = req.body;

    if (!req.user) {
        throw new ApiError(401, "User not authenticated");
    }
    const requesterId = req.user._id;

    // Validate businessId format
    if (!mongoose.Types.ObjectId.isValid(businessId)) {
        throw new ApiError(400, "Invalid business ID format");
    }

    // Check if business exists
    const business = await Business.findById(businessId).populate('userId');
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    // Check if business user exists
    if (!business.userId) {
        throw new ApiError(404, "Business owner not found");
    }

    // Check if user is trying to request contact info from their own business
    if (business.userId._id.toString() === requesterId.toString()) {
        throw new ApiError(400, "You cannot request contact info from your own business");
    }

    // Check if user already has an active request for this business
    const existingRequest = await ContactRequest.findOne({
        requester: requesterId,
        business: businessId
    });

    if (existingRequest) {
        throw new ApiError(409, "You already have a contact request for this business");
    }

    // Create new contact request
    const contactRequest = await ContactRequest.create({
        requester: requesterId,
        business: businessId,
        businessOwner: business.userId._id,
        message: message || '',
        status: 'pending'
    });

    // Tell the owner. Fire-and-forget on purpose, exactly like the follow flow
    // (follower.controllers.js): the request has already been persisted and a
    // notification failure must not turn a successful 201 into an error.
    createContactRequestNotification({
        recipientId: business.userId._id,
        sourceUserId: requesterId,
        businessId,
        businessName: business.businessName,
        requestId: contactRequest._id,
        requestMessage: message
    })?.catch(() => { });

    // Populate the request with user and business details for response
    const populatedRequest = await ContactRequest.findById(contactRequest._id)
        .populate('requester', 'username fullName profileImageUrl')
        .populate('business', 'businessName logoUrl')
        .populate('businessOwner', 'username fullName');

    res.status(201).json(
        new ApiResponse(201, populatedRequest, "Contact request sent successfully")
    );
});

// GET /api/v1/contact-requests/status/:businessId
const getRequestStatus = asyncHandler(async (req, res) => {
    const { businessId } = req.params;

    if (!req.user) {
        throw new ApiError(401, "User not authenticated");
    }
    const requesterId = req.user._id;

    // Validate businessId format
    if (!mongoose.Types.ObjectId.isValid(businessId)) {
        throw new ApiError(400, "Invalid business ID format");
    }

    // Find the request
    const request = await ContactRequest.findOne({
        requester: requesterId,
        business: businessId
    }).populate('business', 'businessName logoUrl contact')
        .populate('businessOwner', 'username fullName');

    if (!request) {
        throw new ApiError(404, "No contact request found for this business");
    }

    // If request is approved, include business contact information
    let responseData = {
        _id: request._id,
        status: request.status,
        message: request.message,
        responseMessage: request.responseMessage,
        business: {
            _id: request.business._id,
            businessName: request.business.businessName,
            logoUrl: request.business.logoUrl
        },
        createdAt: request.createdAt,
        respondedAt: request.respondedAt
    };

    if (request.status === 'approved') {
        responseData.contactInfo = request.business.contact;
    }

    res.status(200).json(
        new ApiResponse(200, responseData, "Request status retrieved successfully")
    );
});

// GET /api/v1/contact-requests/business/:businessId
const getBusinessRequests = asyncHandler(async (req, res) => {
    const { businessId } = req.params;

    if (!req.user) {
        throw new ApiError(401, "User not authenticated");
    }
    const userId = req.user._id;
    const { status, page = 1, limit = 10 } = req.query;

    // Validate businessId format
    if (!mongoose.Types.ObjectId.isValid(businessId)) {
        throw new ApiError(400, "Invalid business ID format");
    }

    // Check if business exists and belongs to the user
    const business = await Business.findById(businessId);
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    if (!business.userId) {
        throw new ApiError(404, "Business owner not found");
    }

    if (business.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only view requests for your own business");
    }

    // Build query
    const query = { business: businessId };
    if (status && ['pending', 'approved', 'denied'].includes(status)) {
        query.status = status;
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get requests with pagination
    const requests = await ContactRequest.find(query)
        .populate('requester', 'username fullName profileImageUrl')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    // Get total count for pagination
    const totalRequests = await ContactRequest.countDocuments(query);

    const pagination = {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalRequests / parseInt(limit)),
        totalRequests,
        hasNextPage: skip + requests.length < totalRequests,
        hasPrevPage: parseInt(page) > 1
    };

    res.status(200).json(
        new ApiResponse(200, { requests, pagination }, "Business requests retrieved successfully")
    );
});

// PATCH /api/v1/contact-requests/:requestId/respond
const respondToRequest = asyncHandler(async (req, res) => {
    const { requestId } = req.params;
    const { status, responseMessage } = req.body;

    if (!req.user) {
        throw new ApiError(401, "User not authenticated");
    }
    const userId = req.user._id;

    // Validate requestId format
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
        throw new ApiError(400, "Invalid request ID format");
    }

    // Validate status
    if (!status || !['approved', 'denied'].includes(status)) {
        throw new ApiError(400, "Status must be either 'approved' or 'denied'");
    }

    // Find the request
    const request = await ContactRequest.findById(requestId);
    if (!request) {
        throw new ApiError(404, "Contact request not found");
    }

    // Check if the user owns the business
    if (!request.businessOwner) {
        throw new ApiError(404, "Business owner not found in request");
    }

    if (request.businessOwner.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only respond to requests for your own business");
    }

    // Check if request is still pending
    if (request.status !== 'pending') {
        // The same answer again (a second tap on the notification's button, or
        // the same request answered from another device) is not an error.
        if (request.status === status) {
            const current = await ContactRequest.findById(requestId)
                .populate('requester', 'username fullName profileImageUrl')
                .populate('business', 'businessName logoUrl');
            return res.status(200).json(
                new ApiResponse(200, current, `Contact request ${status} successfully`)
            );
        }
        throw new ApiError(400, request.status === 'approved'
            ? "You already shared your contact details for this request"
            : "You already declined this request");
    }

    // Update the request
    request.status = status;
    request.responseMessage = responseMessage || '';
    request.respondedAt = new Date();

    await request.save();

    // Populate the updated request for response
    const updatedRequest = await ContactRequest.findById(requestId)
        .populate('requester', 'username fullName profileImageUrl')
        .populate('business', 'businessName logoUrl');

    // Close the loop for the person who asked — same fire-and-forget contract.
    createContactResponseNotification({
        recipientId: request.requester,
        sourceUserId: userId,
        businessId: request.business,
        businessName: updatedRequest?.business?.businessName,
        requestId: request._id,
        status,
        responseMessage: request.responseMessage
    })?.catch(() => { });

    res.status(200).json(
        new ApiResponse(200, updatedRequest, `Contact request ${status} successfully`)
    );
});

export {
    sendContactRequest,
    getRequestStatus,
    getBusinessRequests,
    respondToRequest
};