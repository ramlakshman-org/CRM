import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  ingestLead: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/api/v1/leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/leads')>();
  return { ...actual, ingestLead: mocks.ingestLead };
});

import { POST } from './route';

const payload = {
  source: 'devine_b2b',
  external_id: 'lead-42',
  title: 'Dealer enquiry',
  contact: { phone: '+919876543210' },
};

describe('POST /api/v1/leads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiKey.mockResolvedValue({
      supabase: { marker: 'db' },
      accountId: 'account-1',
    });
  });

  it('requires leads:write and returns 201 for a new deal', async () => {
    mocks.ingestLead.mockResolvedValue({
      created: true,
      contact_id: 'contact-1',
      deal: { id: 'deal-1' },
    });

    const response = await POST(
      new Request('https://example.test/api/v1/leads', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    );

    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.any(Request),
      'leads:write'
    );
    expect(mocks.ingestLead).toHaveBeenCalledWith(
      { marker: 'db' },
      'account-1',
      expect.objectContaining({ source: 'devine_b2b', externalId: 'lead-42' })
    );
    expect(response.status).toBe(201);
  });

  it('returns 200 when the external lead id is retried', async () => {
    mocks.ingestLead.mockResolvedValue({
      created: false,
      contact_id: 'contact-1',
      deal: { id: 'deal-1' },
    });

    const response = await POST(
      new Request('https://example.test/api/v1/leads', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    );
    expect(response.status).toBe(200);
  });
});
