import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaOption, PlatformsResponse } from '@vd/shared';
import { FormatOptions } from '@/components/format-options';
import { PlatformInfo } from '@/components/platform-info';
import { PlatformNotice } from '@/components/platform-notice';
import { ResultCard } from '@/components/result-card';
import { getPlatforms } from '@/lib/api-client';
import { completedJob, MP3_OPTION, MP4_OPTION, unavailableResolve } from '@/test/fixtures';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, getPlatforms: vi.fn() };
});

afterEach(() => {
  vi.mocked(getPlatforms).mockReset();
});

describe('FormatOptions', () => {
  it('renders exactly the options it is given — never more', () => {
    render(<FormatOptions options={[MP3_OPTION]} onSelect={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /mp3 audio/i })).toBeInTheDocument();
    expect(screen.queryByText(/mp4/i)).not.toBeInTheDocument();
  });

  it('shows resolution and size only when they are present', () => {
    const detailed: MediaOption = { ...MP4_OPTION, resolution: '1280×720', sizeBytes: 12 * 1024 * 1024, note: 'Original quality.' };
    const { rerender } = render(<FormatOptions options={[detailed]} onSelect={vi.fn()} />);
    expect(screen.getByText(/1280×720/)).toBeInTheDocument();
    expect(screen.getByText(/12\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText('Original quality.')).toBeInTheDocument();

    rerender(<FormatOptions options={[MP4_OPTION]} onSelect={vi.fn()} />);
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
    expect(screen.queryByText(/MB|KB/)).not.toBeInTheDocument();
  });

  it('reports the chosen format', async () => {
    const onSelect = vi.fn();
    render(<FormatOptions options={[MP4_OPTION, MP3_OPTION]} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /mp3 audio/i }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(MP3_OPTION);
  });

  it('says so when there is nothing to offer instead of inventing options', () => {
    render(<FormatOptions options={[]} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/no downloadable formats/i)).toBeInTheDocument();
  });
});

describe('PlatformNotice', () => {
  const availability = unavailableResolve().availability;
  if (availability.status !== 'unavailable') throw new Error('fixture must be unavailable');

  it('explains the limitation, lists guidance and offers the upload fallback', async () => {
    const onConvertOwnFile = vi.fn();
    render(<PlatformNotice reason={availability.reason} platformName="YouTube" onConvertOwnFile={onConvertOwnFile} />);

    expect(screen.getByText(/YouTube provides no API for downloading video files/)).toBeInTheDocument();
    const guidance = screen.getByRole('list', { name: /what you can do/i });
    expect(within(guidance).getAllByRole('listitem')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /convert a file you own/i }));
    expect(onConvertOwnFile).toHaveBeenCalledOnce();
  });

  it('hides the upload action when no handler is provided', () => {
    render(<PlatformNotice reason={availability.reason} platformName="YouTube" />);
    expect(screen.queryByRole('button', { name: /convert a file you own/i })).not.toBeInTheDocument();
  });
});

describe('ResultCard', () => {
  const result = completedJob().result!;

  it('offers a real download link and honest details', () => {
    render(<ResultCard result={result} onRefreshLink={vi.fn().mockResolvedValue(null)} onReset={vi.fn()} />);
    const link = screen.getByRole('link', { name: /download mp4/i });
    expect(link).toHaveAttribute('href', result.download.url);
    expect(link).toHaveAttribute('download', 'My reel.mp4');
    expect(screen.getByTestId('result-filename')).toHaveTextContent('My reel.mp4');
    expect(screen.getByText('1080×1920')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
    expect(screen.getByText(/original quality — the video was not re-encoded/i)).toBeInTheDocument();
  });

  it('does not claim lossless output unless the worker said so', () => {
    render(<ResultCard result={{ ...result, losslessVideo: false }} onRefreshLink={vi.fn()} onReset={vi.fn()} />);
    expect(screen.queryByText(/not re-encoded/i)).not.toBeInTheDocument();
  });

  it('refreshes the link and surfaces a refresh failure', async () => {
    const onRefreshLink = vi
      .fn()
      .mockResolvedValueOnce({ code: 'LINK_EXPIRED', message: 'That file has expired.', guidance: [], retryable: false });
    render(<ResultCard result={result} onRefreshLink={onRefreshLink} onReset={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /refresh link/i }));
    expect(onRefreshLink).toHaveBeenCalledOnce();
    expect(await screen.findByText('That file has expired.')).toBeInTheDocument();
  });
});

describe('PlatformInfo', () => {
  const response: PlatformsResponse = {
    platforms: [
      { platform: 'youtube', name: 'YouTube', configured: true, capability: 'metadata-only', summary: 'Details only; no download API.' },
      { platform: 'instagram', name: 'Instagram', configured: true, capability: 'own-media', summary: 'Your own posts via the official API.' },
      { platform: 'facebook', name: 'Facebook', configured: false, capability: 'own-media', summary: 'Your own Page videos.' },
    ],
    limits: { maxUploadBytes: 500 * 1024 * 1024, maxDurationSeconds: 3600, fileTtlMinutes: 60 },
  };

  it('loads on first open and badges each platform by capability', async () => {
    vi.mocked(getPlatforms).mockResolvedValue(response);
    render(<PlatformInfo />);
    await userEvent.click(screen.getByText(/what can mediadock download/i));

    expect(await screen.findByText('Details only; no download API.')).toBeInTheDocument();
    expect(screen.getByText('Details only')).toBeInTheDocument();
    expect(screen.getAllByText('Your own media')).toHaveLength(2);
    expect(screen.getAllByText('Not connected')).toHaveLength(1);
    expect(screen.getByText(/500 MB/)).toBeInTheDocument();
    expect(getPlatforms).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when the platforms call fails', async () => {
    vi.mocked(getPlatforms).mockRejectedValue(new Error('down'));
    render(<PlatformInfo />);
    await userEvent.click(screen.getByText(/what can mediadock download/i));
    expect(await screen.findByText(/couldn't load the platform details/i)).toBeInTheDocument();
  });
});
