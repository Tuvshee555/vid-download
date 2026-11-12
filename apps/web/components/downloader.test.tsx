import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Downloader } from '@/components/downloader';
import {
  ApiClientError,
  createJob,
  createUploadTicket,
  getJob,
  getPlatforms,
  resolveUrl,
  uploadFile,
} from '@/lib/api-client';
import { availableResolve, completedJob, JOB_ID, unavailableResolve } from '@/test/fixtures';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    resolveUrl: vi.fn(),
    createJob: vi.fn(),
    getJob: vi.fn(),
    getPlatforms: vi.fn(),
    createUploadTicket: vi.fn(),
    uploadFile: vi.fn(),
  };
});

const IG = 'https://www.instagram.com/reel/Cabc123XYZ/';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

beforeEach(() => {
  vi.mocked(getPlatforms).mockResolvedValue({
    platforms: [],
    limits: { maxUploadBytes: 500 * 1024 * 1024, maxDurationSeconds: 3600, fileTtlMinutes: 60 },
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

function mount() {
  const user = userEvent.setup();
  render(<Downloader />);
  return { user, input: screen.getByRole('textbox', { name: /media link/i }) as HTMLInputElement };
}

describe('Downloader flow', () => {
  it('link → options → MP3 job → result, then "New download" clears the field', async () => {
    vi.mocked(resolveUrl).mockResolvedValue(availableResolve());
    vi.mocked(createJob).mockResolvedValue({ id: JOB_ID, status: 'queued' });
    vi.mocked(getJob).mockResolvedValue(completedJob({ format: 'mp3' }));
    const { user, input } = mount();

    await user.type(input, IG);
    await user.click(screen.getByRole('button', { name: /get download options/i }));

    const formats = await screen.findByRole('list', { name: /available formats/i });
    expect(within(formats).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTestId('media-title')).toHaveTextContent('My reel');

    await user.click(within(formats).getByRole('button', { name: /mp3 audio/i }));
    expect(createJob).toHaveBeenCalledWith({ source: 'url', url: IG, format: 'mp3' }, expect.any(AbortSignal));

    expect(await screen.findByTestId('result-card')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download mp4/i })).toHaveAttribute('href', completedJob().result!.download.url);
    expect(getJob).toHaveBeenCalledWith(JOB_ID, expect.any(AbortSignal));

    await user.click(screen.getByRole('button', { name: /new download/i }));
    expect(screen.queryByTestId('result-card')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /media link/i })).toHaveValue('');
    expect(screen.queryByTestId('platform-chip')).not.toBeInTheDocument();
  });

  it('never offers formats for a link with no permitted download route, and offers the upload instead', async () => {
    vi.mocked(resolveUrl).mockResolvedValue(unavailableResolve());
    const { user, input } = mount();

    await user.type(input, YT);
    await user.click(screen.getByRole('button', { name: /get download options/i }));

    const notice = await screen.findByTestId('platform-notice');
    expect(notice).toHaveTextContent(/YouTube provides no API/);
    expect(screen.queryByRole('list', { name: /available formats/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mp4 video|mp3 audio/i })).not.toBeInTheDocument();
    // the notice carries the CTA, so the generic link is not repeated
    expect(screen.queryByRole('button', { name: /have a file you own/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /convert a file you own/i }));
    expect(await screen.findByTestId('upload-panel')).toBeInTheDocument();
  });

  it('shows the API error with a way forward when the link check fails', async () => {
    vi.mocked(resolveUrl).mockRejectedValue(
      new ApiClientError('PLATFORM_API_ERROR', 'Instagram returned an error. Try again shortly.', { status: 502, retryable: true }),
    );
    const { user, input } = mount();

    await user.type(input, IG);
    await user.click(screen.getByRole('button', { name: /get download options/i }));

    const panel = await screen.findByTestId('flow-error');
    expect(panel).toHaveTextContent('Instagram returned an error. Try again shortly.');

    vi.mocked(resolveUrl).mockResolvedValue(availableResolve());
    await user.click(within(panel).getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('list', { name: /available formats/i })).toBeInTheDocument();
    expect(resolveUrl).toHaveBeenCalledTimes(2);
  });

  it('uploads a file you own via a ticket, then creates the job with the original file name', async () => {
    const uploadId = '8c7bd2e0-1a6e-4b73-9d4a-2f1e0f6b7c21';
    const ticket = {
      uploadId,
      upload: { url: 'http://localhost:4000/v1/uploads/tok', method: 'PUT' as const, headers: { 'content-type': 'video/mp4' }, expiresAt: '2026-11-12T10:10:00.000Z' },
      maxBytes: 500 * 1024 * 1024,
    };
    vi.mocked(createUploadTicket).mockResolvedValue(ticket);
    vi.mocked(uploadFile).mockImplementation(async (_ticket, _file, onProgress) => onProgress(1));
    vi.mocked(createJob).mockResolvedValue({ id: JOB_ID, status: 'queued' });
    vi.mocked(getJob).mockResolvedValue(completedJob());
    const { user } = mount();

    await user.click(screen.getByRole('button', { name: /have a file you own/i }));
    const panel = await screen.findByTestId('upload-panel');

    const file = new File([new Uint8Array(2048)], 'holiday.mp4', { type: 'video/mp4' });
    await user.upload(panel.querySelector('input[type=file]') as HTMLInputElement, file);
    expect(within(panel).getByText(/holiday\.mp4/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /convert to mp4/i }));

    await waitFor(() => expect(createJob).toHaveBeenCalled());
    expect(createUploadTicket).toHaveBeenCalledWith(
      { filename: 'holiday.mp4', size: 2048, contentType: 'video/mp4' },
      expect.any(AbortSignal),
    );
    expect(uploadFile).toHaveBeenCalledWith(ticket.upload, file, expect.any(Function), expect.any(AbortSignal));
    expect(createJob).toHaveBeenCalledWith(
      { source: 'upload', uploadId, format: 'mp4', filename: 'holiday.mp4' },
      expect.any(AbortSignal),
    );
    expect(await screen.findByTestId('result-card')).toBeInTheDocument();
  });

  it('rejects unsupported and oversized files before any network call', async () => {
    vi.mocked(getPlatforms).mockResolvedValue({
      platforms: [],
      limits: { maxUploadBytes: 1024, maxDurationSeconds: 3600, fileTtlMinutes: 60 },
    });
    const { user } = mount();
    await user.click(screen.getByRole('button', { name: /have a file you own/i }));
    const panel = await screen.findByTestId('upload-panel');
    const fileInput = panel.querySelector('input[type=file]') as HTMLInputElement;
    await waitFor(() => expect(getPlatforms).toHaveBeenCalled());
    await screen.findByText(/up to 1\.0 KB/i);

    // `applyAccept: false` so the component's own check (not the browser filter) is exercised.
    const unsafe = userEvent.setup({ applyAccept: false });
    await unsafe.upload(fileInput, new File(['x'], 'payload.exe'));
    expect(await within(panel).findByText(/isn't supported/i)).toBeInTheDocument();

    await unsafe.upload(fileInput, new File([new Uint8Array(4096)], 'big.mp4', { type: 'video/mp4' }));
    expect(await within(panel).findByText(/the limit is 1\.0 KB/i)).toBeInTheDocument();

    expect(createUploadTicket).not.toHaveBeenCalled();
  });
});
