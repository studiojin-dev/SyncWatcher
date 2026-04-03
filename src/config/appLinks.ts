function readPublicUrl(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export const lemonSqueezyCheckoutUrl = readPublicUrl(
    import.meta.env.VITE_LEMON_SQUEEZY_CHECKOUT_URL,
    '',
);

export const githubRepositoryUrl = 'https://github.com/studiojin-dev/SyncWatcher';
export const githubLatestReleaseUrl = `${githubRepositoryUrl}/releases/latest`;
export const termsOfServiceUrl = `${githubRepositoryUrl}/blob/main/TERMS.md`;
export const privacyPolicyUrl = `${githubRepositoryUrl}/blob/main/PRIVACY.md`;
export const appStoreListingUrl = readPublicUrl(
    import.meta.env.VITE_APP_STORE_URL,
    '',
);
