import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobView } from '@vd/shared';
import { Downloader } from '@/components/downloader';
import { ApiClientError, convertStream, createJob, getJob, getPlatforms, resolveUrl } from '@/lib/api-client';
import { availableResolve, completedJob, JOB_ID } from '@/test/fixtures';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, resolveUrl: vi.fn(), createJob: vi.fn(), getJob: vi.fn(), getPlatforms: vi.fn(), convertStream: vi.fn() };
});

const TT = 'https://www.tiktok.com/@realmadrid/video/7707305867162570017';

beforeEach(() => {
  vi.mocked(getPlatforms).mockResolvedValue({ platforms: [], limits: { maxUploadBytes: 1, maxDurationSeconds: 1800, fileTtlMinutes: 60 } });
});
afterEach(() => vi.resetAllMocks());

function mount() {
  const user = userEvent.setup();
  render(<Downloader mode="standalone" />);
  return { user, input: screen.getByRole('textbox', { name: /media link/i }) };
}

describe('Downloader in standalone (single Vercel deployment) mode', () => {
  it('streams progress for the chosen quality and shows the finished download — no polling, no refresh, no upload', async () => {
    vi.mocked(resolveUrl).mockResolvedValue(availableResolve({ platform: 'tiktok', platformName: 'TikTok' }));
    let finish: () => void = () => undefined;
    vi.mocked(convertStream).mockImplementation(async (_body, onUpdate) => {
      const base = { id: JOB_ID, format: 'mp4' as const, createdAt: new Date().toISOString(), attempt: 1, maxAttempts: 1 };
      onUpdate({ ...base, status: 'queued', progress: { stage: 'queued', percent: 0 } });
      onUpdate({ ...base, status: 'processing', progress: { stage: 'downloading', percent: 30 } });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      onUpdate(completedJob({ format: 'mp4' }) as JobView);
    });

    const { user, input } = mount();
    expect(screen.queryByText(/have a file you own/i)).not.toBeInTheDocument();

    await user.type(input, TT);
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    const formats = await screen.findByRole('list', { name: /available formats/i });
    await user.click(within(formats).getAllByRole('button')[0]!);

    expect(convertStream).toHaveBeenCalledWith({ source: 'url', url: TT, format: 'mp4', quality: 720 }, expect.any(Function), expect.any(AbortSignal));
    expect(await screen.findByText(/30\s*%/)).toBeInTheDocument();

    finish();
    const link = await screen.findByRole('link', { name: /download mp4/i });
    expect(link).toHaveAttribute('href', completedJob({ format: 'mp4' }).result!.download.url);
    expect(screen.queryByRole('button', { name: /refresh link/i })).not.toBeInTheDocument();
    expect(createJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
  });

  it('shows the server’s explanation when a conversion fails', async () => {
    vi.mocked(resolveUrl).mockResolvedValue(availableResolve());
    vi.mocked(convertStream).mockImplementation(async (_body, onUpdate) => {
      onUpdate({
        id: JOB_ID,
        format: 'mp3',
        status: 'failed',
        createdAt: new Date().toISOString(),
        attempt: 1,
        maxAttempts: 1,
        progress: { stage: 'done', percent: 0 },
        error: { code: 'PRIVATE_CONTENT', message: 'This Instagram video is private.', retryable: false },
      });
    });
    const { user, input } = mount();
    await user.type(input, 'https://www.instagram.com/reel/Cabc123XYZ/');
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    const formats = await screen.findByRole('list', { name: /available formats/i });
    await user.click(within(formats).getAllByRole('button')[1]!);
    expect(await screen.findByText('This Instagram video is private.')).toBeInTheDocument();
  });

  it('reports a dropped connection as a retryable error', async () => {
    vi.mocked(resolveUrl).mockResolvedValue(availableResolve());
    vi.mocked(convertStream).mockRejectedValue(new ApiClientError('NETWORK_TIMEOUT', 'The connection dropped while converting. Please try again.', { retryable: true }));
    const { user, input } = mount();
    await user.type(input, 'https://www.instagram.com/reel/Cabc123XYZ/');
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    const formats = await screen.findByRole('list', { name: /available formats/i });
    await user.click(within(formats).getAllByRole('button')[0]!);
    expect(await screen.findByText(/connection dropped/i)).toBeInTheDocument();
  });
});
