import { describe, expect, it } from 'vitest';

import { LeadError, parseLeadInput } from './leads';

const FIELD_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

describe('parseLeadInput', () => {
  it('normalizes a valid external lead payload', () => {
    expect(
      parseLeadInput({
        source: 'DEVINE_B2B',
        external_id: 'lead-42',
        title: '  New dealer enquiry  ',
        contact: {
          phone: '+919876543210',
          name: ' Buyer Name ',
          company: ' Buyer Company ',
        },
        sales_intent: 'high',
        requested_action: 'Discuss order',
        assigned_to_user_id: USER_ID,
        tag_ids: [TAG_ID, TAG_ID],
        custom_fields: { [FIELD_ID]: ' Distributor ' },
      })
    ).toEqual({
      source: 'devine_b2b',
      externalId: 'lead-42',
      title: 'New dealer enquiry',
      contact: {
        phone: '+919876543210',
        name: 'Buyer Name',
        company: 'Buyer Company',
      },
      salesIntent: 'high',
      requestedAction: 'Discuss order',
      assignedToUserId: USER_ID,
      tagIds: [TAG_ID],
      customFields: { [FIELD_ID]: 'Distributor' },
    });
  });

  it('defaults optional collections safely', () => {
    const input = parseLeadInput({
      source: 'devine_b2b',
      external_id: 'lead-43',
      title: 'Dealer enquiry',
      contact: { phone: '+919876543210' },
    });
    expect(input.salesIntent).toBe('normal');
    expect(input.tagIds).toEqual([]);
    expect(input.customFields).toEqual({});
  });

  it.each([
    [{}, "'source' is required"],
    [
      {
        source: 'bad source',
        external_id: '1',
        title: 'Lead',
        contact: { phone: '+919876543210' },
      },
      "'source' must use lowercase letters, numbers, underscores, or hyphens",
    ],
    [
      {
        source: 'devine_b2b',
        external_id: '1',
        title: 'Lead',
        contact: { phone: '+919876543210' },
        sales_intent: 'urgent',
      },
      "'sales_intent' must be 'normal' or 'high'",
    ],
    [
      {
        source: 'devine_b2b',
        external_id: '1',
        title: 'Lead',
        contact: { phone: '+919876543210' },
        tag_ids: ['not-a-uuid'],
      },
      "'tag_ids[]' must be a UUID",
    ],
  ])('rejects malformed input %#', (body, message) => {
    expect(() => parseLeadInput(body)).toThrowError(message);
    try {
      parseLeadInput(body);
    } catch (error) {
      expect(error).toBeInstanceOf(LeadError);
      expect(error).toMatchObject({ code: 'bad_request', status: 400 });
    }
  });
});
