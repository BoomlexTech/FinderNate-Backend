import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Found 21 Nov 2026 with a signed-out crawl of findernate.com: searching
// "findernate" listed a private account's posts, and opening one answered
// "Post not found". User results also carried each account's latest posts and
// reels whatever their privacy.

const src = await readFile(new URL('../../src/controllers/searchAllContent.controllers.js', import.meta.url), 'utf8');

test('search filters its post and reel results by what the viewer may open', () => {
    assert.match(src, /import \{ createPostVisibilityChecker \} from "\.\/post\/visibility\.js"/);
    assert.match(src, /const canSee = createPostVisibilityChecker\(req\.user\?\._id \|\| null\)/);
    // Filtered before paging, so page sizes and totals stay right.
    const filterAt = src.indexOf('.filter((_, i) => mayOpen[i])');
    const pageAt = src.indexOf('const paginatedContent = combinedContent.slice');
    assert.ok(filterAt > 0 && pageAt > filterAt, 'filter runs before the page is cut');
});

test("a user result's recent posts follow the account's privacy", () => {
    assert.match(src, /const accountVisible = isSelf \|\| await canSee\(\{ userId: user\._id \}\)/);
    assert.match(src, /'settings\.privacy': \{ \$ne: 'private' \}/);
    assert.match(src, /isPublic: true/);
    // The unfiltered queries are gone.
    assert.doesNotMatch(src, /Post\.find\(\{ userId: user\._id \}\)/);
    assert.doesNotMatch(src, /Reel\.find\(\{ userId: user\._id \}\)/);
});

test('the search cache is per viewer, so a per-viewer filter cannot leak through it', async () => {
    const cache = await readFile(new URL('../../src/middlewares/cache.middleware.js', import.meta.url), 'utf8');
    const block = cache.slice(cache.indexOf('export const cacheSearchResults'), cache.indexOf('export const cacheBusinessProfile'));
    assert.match(block, /req\.user\?\._id\?\.toString\(\) \?\? null/);
});
