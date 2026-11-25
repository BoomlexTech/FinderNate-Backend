import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Found 25 Nov 2026 by checking the whole backend for names that are used but
// never defined, after one of them took instant search down (see
// instant-search-listings.test.js). Each of these threw "X is not defined" the
// moment its line ran.

const read = (path) => readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8');
// Code only: the fixes explain themselves in comments that quote the old text.
const withoutComments = (src) => src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

test('admin report review: the open statuses are strings, not variable names', async () => {
    const code = withoutComments(await read('controllers/admin/reports.controllers.js'));
    assert.doesNotMatch(code, /\[\s*pending\s*,\s*under_review\s*\]/);
    assert.match(code, /!\['pending', 'under_review'\]\.includes\(status\)/);
    assert.match(code, /status: \{ \$in: \['pending', 'under_review'\] \}/);
    // And they are statuses the Report model really has.
    const model = await read('models/report.models.js');
    assert.match(model, /enum: \['pending', 'under_review', 'reviewed', 'resolved', 'dismissed'\]/);
});

test('guest checkout: every email helper the account-ready email uses is imported', async () => {
    const src = await read('utils/guestCheckout.utils.js');
    const imported = src.match(/import \{([^}]*)\} from "\.\/emailTemplate\.js"/);
    assert.ok(imported, 'the emailTemplate import is still there');
    const names = new Set(withoutComments(imported[1]).split(',').map((name) => name.trim()).filter(Boolean));
    const used = new Set([...withoutComments(src).matchAll(/\b((?:email|render)[A-Z]\w*)\(/g)].map((m) => m[1]));
    assert.ok(used.has('emailCodeBlock'), 'the one-time code is still shown with emailCodeBlock');
    for (const name of used) assert.ok(names.has(name), `${name} is imported from emailTemplate.js`);

    // The helper exists under that name.
    assert.match(await read('utils/emailTemplate.js'), /export const emailCodeBlock = /);
});

test('checkout link order: no leftover of the removed seller-set link', async () => {
    const code = withoutComments(await read('controllers/payments.controllers.js'));
    assert.doesNotMatch(code, /\bsellerSetLink\b/);
    // The link is still looked up by post and figure before one is created.
    const handler = code.slice(code.indexOf('export const createShareableCashfreeOrder'));
    assert.match(handler, /let paymentLink = await PaymentLink\.findOne\(\{\s*postId,\s*amount: numericAmount,\s*status: 'active',\s*isShareableLink: true\s*\}\);/);
});
