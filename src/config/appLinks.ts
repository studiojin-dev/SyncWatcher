const DEFAULT_LEMON_SQUEEZY_CHECKOUT_URL = 'https://studiojin.lemonsqueezy.com/checkout/buy/1301030';
const DEFAULT_BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/studiojin_dev';

function readPublicUrl(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export const lemonSqueezyCheckoutUrl = readPublicUrl(
    import.meta.env.VITE_LEMON_SQUEEZY_CHECKOUT_URL,
    DEFAULT_LEMON_SQUEEZY_CHECKOUT_URL,
);

export const buyMeACoffeeUrl = readPublicUrl(
    import.meta.env.VITE_BUY_ME_A_COFFEE_URL,
    DEFAULT_BUY_ME_A_COFFEE_URL,
);

export const githubRepositoryUrl = 'https://github.com/studiojin-dev/SyncWatcher';
export const githubLatestReleaseUrl = `${githubRepositoryUrl}/releases/latest`;
