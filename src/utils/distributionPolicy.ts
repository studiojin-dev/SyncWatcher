import type { DistributionInfo } from '../context/DistributionContext';

export type DistributionChannel = DistributionInfo['channel'];
export type SupporterProvider = DistributionInfo['purchaseProvider'];

export interface ChannelPolicy {
    channel: DistributionChannel;
    purchaseProvider: SupporterProvider;
    supportsLicenseKeys: boolean;
    supportsExternalCheckout: boolean;
    supportsStoreKitPurchase: boolean;
    supportsStoreKitRestore: boolean;
    supportsSelfUpdate: boolean;
    requiresSecurityScopedBookmarks: boolean;
}

export function getDistributionPolicy(
    distribution: Pick<DistributionInfo, 'channel' | 'purchaseProvider' | 'canSelfUpdate'>,
): ChannelPolicy {
    const isAppStore = distribution.channel === 'app_store';

    return {
        channel: distribution.channel,
        purchaseProvider: distribution.purchaseProvider,
        supportsLicenseKeys: !isAppStore,
        supportsExternalCheckout: !isAppStore,
        supportsStoreKitPurchase: isAppStore,
        supportsStoreKitRestore: isAppStore,
        supportsSelfUpdate: distribution.canSelfUpdate,
        requiresSecurityScopedBookmarks: isAppStore,
    };
}

export function assertSupporterProviderMatchesPolicy(
    policy: ChannelPolicy,
    provider: SupporterProvider,
): void {
    if (policy.purchaseProvider !== provider) {
        throw new Error(
            `Supporter provider mismatch: expected ${policy.purchaseProvider}, received ${provider}.`,
        );
    }
}
