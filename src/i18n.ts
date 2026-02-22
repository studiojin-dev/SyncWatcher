import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enTranslation from './locales/en/translation.json';
import koTranslation from './locales/ko/translation.json';
import jaTranslation from './locales/ja/translation.json';
import zhTranslation from './locales/zh/translation.json';
import zhTWTranslation from './locales/zh-TW/translation.json';
import esTranslation from './locales/es/translation.json';

const resources = {
    en: {
        translation: enTranslation.translation
    },
    ko: {
        translation: koTranslation.translation
    },
    ja: {
        translation: jaTranslation.translation
    },
    zh: {
        translation: zhTranslation.translation
    },
    'zh-TW': {
        translation: zhTWTranslation.translation
    },
    es: {
        translation: esTranslation.translation
    }
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: 'en',
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false
        }
    });

export default i18n;
