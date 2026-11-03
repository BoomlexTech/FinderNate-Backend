/**
 * Share Utilities
 * Helper functions for post/reel sharing functionality
 */

/**
 * Determines if a post can be shared
 * @param {Object} post - Post object with settings
 * @returns {Object} - { canShare: boolean, reason: string }
 */
export const canSharePost = (post) => {
  // Check if post exists
  if (!post) {
    return { canShare: false, reason: "Post not found" };
  }

  // Check if post is public
  if (post.settings?.privacy !== "public") {
    return { canShare: false, reason: "Only public posts can be shared" };
  }

  // Check if sharing is enabled
  if (post.settings?.allowShares === false) {
    return { canShare: false, reason: "Sharing is disabled for this post" };
  }

  return { canShare: true, reason: null };
};

/**
 * Generates Open Graph meta tags for a post/reel
 * @param {Object} post - Post object with populated userId
 * @param {String} type - 'post' or 'reel'
 * @returns {Object} - Meta tags object
 */
export const generateOpenGraphMetaTags = (post, type = "post") => {
  const author = post.userId;
  const caption = post.caption
    ? post.caption.length > 200
      ? post.caption.substring(0, 197) + "..."
      : post.caption
    : `Check out this ${type} on FinderNate`;

  const mediaUrl =
    post.media?.[0]?.thumbnailUrl || post.media?.[0]?.url || "";
  const shareUrl = `https://findernate.com/r/${post._id}`;

  const metaTags = {
    "og:title": `${author.fullName || author.username} on FinderNate`,
    "og:description": caption,
    "og:image": mediaUrl,
    "og:url": shareUrl,
    "og:type": type === "reel" ? "video.other" : "article",
    "og:site_name": "FinderNate",
    "twitter:card": "summary_large_image",
    "twitter:title": `${author.fullName || author.username} on FinderNate`,
    "twitter:description": caption,
    "twitter:image": mediaUrl,
  };

  // Add video-specific tags for reels
  if (type === "reel" && post.media?.[0]) {
    metaTags["og:video"] = post.media[0].url;
    metaTags["og:video:type"] = "video/mp4";
    if (post.media[0].dimensions) {
      metaTags["og:video:width"] = post.media[0].dimensions.width;
      metaTags["og:video:height"] = post.media[0].dimensions.height;
    }
  }

  // Add image dimensions for better preview
  if (post.media?.[0]?.dimensions) {
    metaTags["og:image:width"] = post.media[0].dimensions.width || 1200;
    metaTags["og:image:height"] = post.media[0].dimensions.height || 630;
  }

  return metaTags;
};

/**
 * Helper function to escape HTML entities
 * @param {String} str - String to escape
 * @returns {String} - Escaped string
 */
const escapeHtml = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

/**
 * Generates HTML page with Open Graph meta tags
 * @param {Object} post - Post object
 * @param {String} type - 'post' or 'reel'
 * @returns {String} - HTML string
 */
export const generatePreviewHTML = (post, type = "post") => {
  const metaTags = generateOpenGraphMetaTags(post, type);
  const redirectUrl = metaTags["og:url"];

  const metaTagsHTML = Object.entries(metaTags)
    .map(([key, value]) => {
      const property = key.startsWith("og:") || key.startsWith("twitter:")
        ? "property"
        : "name";
      return `<meta ${property}="${key}" content="${escapeHtml(value)}">`;
    })
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(metaTags["og:title"])}</title>

  ${metaTagsHTML}

  <meta http-equiv="refresh" content="0; url=${redirectUrl}">

  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
    }
    .logo {
      font-size: 48px;
      font-weight: bold;
      margin-bottom: 20px;
    }
    .message {
      font-size: 18px;
      margin-bottom: 30px;
    }
    .loader {
      border: 4px solid rgba(255,255,255,0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">FinderNate</div>
    <div class="message">Loading ${type}...</div>
    <div class="loader"></div>
  </div>
  <script>
    window.location.href = '${redirectUrl}';
  </script>
</body>
</html>`;
};

/**
 * Generates error HTML page
 * @param {String} errorMessage - Error message to display
 * @returns {String} - HTML string
 */
export const generateErrorHTML = (errorMessage) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinderNate</title>
  <meta property="og:title" content="FinderNate">
  <meta property="og:description" content="Discover and share moments on FinderNate">
  <meta property="og:image" content="https://findernate.com/logo.png">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-align: center;
    }
    .container {
      max-width: 500px;
      padding: 20px;
    }
    .logo {
      font-size: 48px;
      font-weight: bold;
      margin-bottom: 20px;
    }
    .error {
      font-size: 24px;
      margin-bottom: 30px;
    }
    .message {
      font-size: 16px;
      opacity: 0.9;
    }
    .btn {
      display: inline-block;
      margin-top: 30px;
      padding: 12px 30px;
      background: white;
      color: #764ba2;
      text-decoration: none;
      border-radius: 25px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">FinderNate</div>
    <div class="error">${escapeHtml(errorMessage)}</div>
    <div class="message">This post may be private, deleted, or unavailable.</div>
    <a href="https://findernate.com" class="btn">Go to FinderNate</a>
  </div>
</body>
</html>`;
};

/**
 * Sanitizes post data for guest/public viewing
 * @param {Object} post - Post object
 * @param {Object} viewer - Current viewer (null for guests)
 * @returns {Object} - Sanitized post object
 */
export const sanitizePostForGuest = (post, viewer = null) => {
  const sanitized = {
    _id: post._id,
    postType: post.postType,
    contentType: post.contentType,
    caption: post.caption,
    description: post.description,
    media: post.media,
    engagement: {
      likes: post.engagement?.likes || 0,
      comments: post.engagement?.comments || 0,
      shares: post.engagement?.shares || 0,
      views: post.engagement?.views || 0,
    },
    createdAt: post.createdAt,
    author: {
      username: post.userId?.username,
      fullName: post.userId?.fullName,
      profileImageUrl: post.userId?.profileImageUrl,
    },
    // The author's per-post switches (Phase 2 #18), so the public page can
    // hide the like / comment / share buttons the author turned off.
    settings: {
      allowLikes: post.settings?.allowLikes !== false,
      allowComments: post.settings?.allowComments !== false,
      allowShares: post.settings?.allowShares !== false,
    },
  };

  // Only include viewer-specific fields if viewer is logged in
  if (viewer) {
    sanitized.isLikedBy = post.isLikedBy || false;
    sanitized.likedBy = post.likedBy || [];
  }

  // Include product/service/business details if public
  if (post.contentType === "product" && post.customization?.product) {
    sanitized.product = {
      name: post.customization.product.name,
      description: post.customization.product.description,
      price: post.customization.product.price,
      currency: post.customization.product.currency,
      link: post.customization.product.link,
    };
  }

  if (post.contentType === "service" && post.customization?.service) {
    sanitized.service = {
      name: post.customization.service.name,
      description: post.customization.service.description,
      price: post.customization.service.price,
      currency: post.customization.service.currency,
      link: post.customization.service.link,
    };
  }

  if (post.contentType === "business" && post.customization?.business) {
    sanitized.business = {
      businessName: post.customization.business.businessName,
      description: post.customization.business.description,
      category: post.customization.business.category,
      link: post.customization.business.link,
    };
  }

  return sanitized;
};
