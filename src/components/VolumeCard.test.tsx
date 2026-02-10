import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VolumeCard from './VolumeCard';

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string, fallback?: string) => {
      const translations: Record<string, string> = {
        'dashboard.networkCapacityUnavailable': 'N/A - 네트워크 연결',
      };
      return translations[key] ?? fallback ?? key;
    }),
  })),
}));

describe('VolumeCard', () => {
  it('renders free and total capacity for local volume', () => {
    render(
      <VolumeCard
        volume={{
          name: 'USB',
          mount_point: '/Volumes/USB',
          total_bytes: 100 * 1000 * 1000,
          available_bytes: 40 * 1000 * 1000,
          is_network: false,
          is_removable: true,
        }}
      />
    );

    expect(screen.getByText('/Volumes/USB')).toBeInTheDocument();
    expect(screen.getByText(/FREE/)).toBeInTheDocument();
    expect(screen.getByText(/\/ 100 MB/)).toBeInTheDocument();
  });

  it('renders network N/A label when capacity is unavailable', () => {
    render(
      <VolumeCard
        volume={{
          name: 'NAS',
          mount_point: '/Volumes/NAS',
          total_bytes: null,
          available_bytes: null,
          is_network: true,
          is_removable: false,
        }}
      />
    );

    expect(screen.getByText('/Volumes/NAS')).toBeInTheDocument();
    expect(screen.getByText('N/A - 네트워크 연결')).toBeInTheDocument();
  });
});
