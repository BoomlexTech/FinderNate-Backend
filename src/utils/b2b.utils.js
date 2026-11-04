import Business from '../models/business.models.js';
import { getSettingValue } from './appSettings.utils.js';
import { getFeeRates } from './fees.utils.js';
import { commissionFor, effectiveKycStatus, isB2B } from './phase4.rules.js';

/**
 * Commission for a new order (Phase 4 #74, Q11): 10% when buyer and seller
 * are both verified businesses, otherwise the normal platform fee (2.5%).
 * Both rates are admin settings (B2B_COMMISSION_RATE, PLATFORM_FEE).
 */
export const classifyOrderCommission = async (buyerId, sellerId, amount) => {
    const [buyer, seller] = await Promise.all([
        buyerId ? Business.findOne({ userId: buyerId }).select('kyc verificationStatus').lean() : null,
        sellerId ? Business.findOne({ userId: sellerId }).select('kyc verificationStatus').lean() : null,
    ]);
    const b2b = isB2B(buyer ? effectiveKycStatus(buyer) : 'none', seller ? effectiveKycStatus(seller) : 'none');
    const { platformFeeRate } = await getFeeRates();
    const b2bRate = Number(await getSettingValue('B2B_COMMISSION_RATE', 0.10));
    const { rate, commission, sellerNet } = commissionFor(amount || 0, {
        b2b,
        b2bRate: Number.isFinite(b2bRate) ? b2bRate : 0.10,
        normalRate: platformFeeRate,
    });
    return { isB2B: b2b, commissionRate: rate, commissionAmount: commission, sellerNetAmount: sellerNet };
};
