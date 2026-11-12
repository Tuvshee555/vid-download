// Types for the jest-dom matchers (toBeInTheDocument, …) on vitest's `expect`.
import '@testing-library/jest-dom/vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

// Extend the `expect` this test run actually uses. The side-effect import above can end up
// patching a different copy of vitest's `expect` depending on how modules are deduplicated,
// which shows up as "Invalid Chai property: toBeInTheDocument" only in multi-file runs.
expect.extend(matchers);

afterEach(() => {
  cleanup();
});
