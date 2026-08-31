import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  getLeadIntakeOptions: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/api/v1/leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/leads')>();
  return { ...actual, getLeadIntakeOptions: mocks.getLeadIntakeOptions };
});

import { GET } from './route';

describe('GET /api/v1/leads/options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiKey.mockResolvedValue({
      supabase: { marker: 'db' },
      accountId: 'account-1',
    });
  });

  it('returns account metadata using the leads:write scope', async () => {
    mocks.getLeadIntakeOptions.mockResolvedValue({
      enabled: true,
      pipeline: { id: 'pipeline-1', name: 'Sales' },
      initial_stage: { id: 'stage-1', name: 'New lead' },
      default_salesperson_user_id: null,
      tags: [],
      custom_fields: [],
      salespeople: [],
    });

    const response = await GET(
      new Request('https://example.test/api/v1/leads/options')
    );
    const body = await response.json();

    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'leads:write'
    );
    expect(mocks.getLeadIntakeOptions).toHaveBeenCalledWith(
      { marker: 'db' },
      'account-1'
    );
    expect(response.status).toBe(200);
    expect(body.data.enabled).toBe(true);
  });
});
