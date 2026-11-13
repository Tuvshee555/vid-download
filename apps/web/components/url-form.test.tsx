import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UrlForm } from '@/components/url-form';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function setup(props: Partial<React.ComponentProps<typeof UrlForm>> = {}) {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<UrlForm onSubmit={onSubmit} {...props} />);
  return { onSubmit, user, input: screen.getByRole('textbox', { name: /media link/i }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UrlForm', () => {
  it.each([
    [YT, 'YouTube'],
    ['https://www.instagram.com/reel/Cabc123XYZ/', 'Instagram'],
    ['https://www.facebook.com/watch/?v=1234567890123', 'Facebook'],
  ])('detects the platform for %s', async (url, name) => {
    const { user, input } = setup();
    await user.type(input, url);
    expect(screen.getByTestId('platform-chip')).toHaveTextContent(`${name} link detected`);
  });

  it('shows no chip for unknown sites', async () => {
    const { user, input } = setup();
    await user.type(input, 'https://vimeo.com/123456');
    expect(screen.queryByTestId('platform-chip')).not.toBeInTheDocument();
  });

  it('submits a valid link, trimmed', async () => {
    const { user, input, onSubmit } = setup();
    await user.type(input, `  ${YT}  `);
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(YT);
  });

  it('shows an inline message and does not submit an empty form', async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    expect(screen.getByText(/paste a youtube, instagram or facebook link first/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['not a url at all', /valid web address|spaces/i],
    ['https://vimeo.com/123456', /isn't supported/i],
    ['http://localhost:3000/secret', /local or private/i],
    ['https://www.youtube.com/@channel', /not a single video/i],
  ])('rejects %s inline without calling the API', async (value, message) => {
    const { user, input, onSubmit } = setup();
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: /^download$/i }));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fills the input from the clipboard when Paste is clicked', async () => {
    const { user, input } = setup();
    const readText = vi.fn().mockResolvedValue(`  ${YT}\n`);
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });

    await user.click(screen.getByRole('button', { name: /paste/i }));
    await waitFor(() => expect(input).toHaveValue(YT));
    expect(readText).toHaveBeenCalledOnce();
    expect(screen.getByTestId('platform-chip')).toHaveTextContent('YouTube');
  });

  it('explains what to do when the clipboard cannot be read', async () => {
    const { user, input } = setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: /paste/i }));
    expect(await screen.findByText(/couldn't read the clipboard/i)).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('disables submit and says so while busy', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: /checking link/i })).toBeDisabled();
  });

  it('reports platform changes to the parent', async () => {
    const onPlatformChange = vi.fn();
    const { user, input } = setup({ onPlatformChange });
    await user.type(input, YT);
    expect(onPlatformChange).toHaveBeenLastCalledWith('youtube');
  });
});
