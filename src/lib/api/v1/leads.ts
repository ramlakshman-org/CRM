// ============================================================
// External lead intake core.
//
// This module deliberately creates contacts + deals only. It does not
// create conversations, send WhatsApp messages, or dispatch tag-based
// automations. That keeps the public lead contract independent from
// Meta webhook ownership until a conversation integration is approved.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TAGS = 30;
const MAX_CUSTOM_FIELDS = 50;

export type SalesIntent = 'normal' | 'high';

export interface LeadContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

export interface LeadInput {
  source: string;
  externalId: string;
  title: string;
  contact: LeadContactInput;
  salesIntent: SalesIntent;
  requestedAction?: string | null;
  assignedToUserId?: string;
  tagIds: string[];
  customFields: Record<string, string | null>;
}

export interface IngestedLead {
  created: boolean;
  contact_id: string | null;
  deal: {
    id: string;
    title: string;
    pipeline_id: string;
    stage_id: string;
    contact_id: string | null;
    assigned_to: string | null;
    status: string;
    external_source: string;
    external_lead_id: string;
    sales_intent: SalesIntent;
    requested_action: string | null;
    created_at: string;
    updated_at: string | null;
  };
}

export interface LeadIntakeOptions {
  enabled: boolean;
  pipeline: { id: string; name: string } | null;
  initial_stage: { id: string; name: string } | null;
  default_salesperson_user_id: string | null;
  tags: { id: string; name: string; color: string }[];
  custom_fields: { id: string; name: string; type: string }[];
  salespeople: { user_id: string; name: string; email: string | null }[];
}

export class LeadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'LeadError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LeadError('bad_request', `'${field}' is required`, 400);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new LeadError(
      'bad_request',
      `'${field}' must be ${maxLength} characters or fewer`,
      400
    );
  }
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new LeadError(
      'bad_request',
      `'${field}' must be a string or null`,
      400
    );
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new LeadError(
      'bad_request',
      `'${field}' must be ${maxLength} characters or fewer`,
      400
    );
  }
  return text || null;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new LeadError('bad_request', `'${field}' must be a UUID`, 400);
  }
  return value;
}

/** Validate the stable public payload without touching the database. */
export function parseLeadInput(body: unknown): LeadInput {
  if (!isRecord(body)) {
    throw new LeadError(
      'bad_request',
      'Request body must be a JSON object',
      400
    );
  }

  const source = requiredText(body.source, 'source', 64).toLowerCase();
  if (!SOURCE_RE.test(source)) {
    throw new LeadError(
      'bad_request',
      "'source' must use lowercase letters, numbers, underscores, or hyphens",
      400
    );
  }

  const externalId = requiredText(body.external_id, 'external_id', 200);
  const title = requiredText(body.title, 'title', 160);

  if (!isRecord(body.contact)) {
    throw new LeadError('bad_request', "'contact' must be an object", 400);
  }
  const contact: LeadContactInput = {
    phone: requiredText(body.contact.phone, 'contact.phone', 40),
  };
  const name = optionalText(body.contact.name, 'contact.name', 160);
  const email = optionalText(body.contact.email, 'contact.email', 320);
  const company = optionalText(body.contact.company, 'contact.company', 200);
  if (name !== undefined) contact.name = name;
  if (email !== undefined) contact.email = email;
  if (company !== undefined) contact.company = company;

  const rawIntent = body.sales_intent ?? 'normal';
  if (rawIntent !== 'normal' && rawIntent !== 'high') {
    throw new LeadError(
      'bad_request',
      "'sales_intent' must be 'normal' or 'high'",
      400
    );
  }

  const requestedAction = optionalText(
    body.requested_action,
    'requested_action',
    120
  );

  let assignedToUserId: string | undefined;
  if (
    body.assigned_to_user_id !== undefined &&
    body.assigned_to_user_id !== null
  ) {
    assignedToUserId = uuid(body.assigned_to_user_id, 'assigned_to_user_id');
  }

  const tagIds: string[] = [];
  if (body.tag_ids !== undefined) {
    if (!Array.isArray(body.tag_ids) || body.tag_ids.length > MAX_TAGS) {
      throw new LeadError(
        'bad_request',
        `'tag_ids' must be an array of at most ${MAX_TAGS} UUIDs`,
        400
      );
    }
    for (const value of body.tag_ids) {
      const id = uuid(value, 'tag_ids[]');
      if (!tagIds.includes(id)) tagIds.push(id);
    }
  }

  const customFields: Record<string, string | null> = {};
  if (body.custom_fields !== undefined) {
    if (!isRecord(body.custom_fields)) {
      throw new LeadError(
        'bad_request',
        "'custom_fields' must be an object",
        400
      );
    }
    const entries = Object.entries(body.custom_fields);
    if (entries.length > MAX_CUSTOM_FIELDS) {
      throw new LeadError(
        'bad_request',
        `'custom_fields' accepts at most ${MAX_CUSTOM_FIELDS} values`,
        400
      );
    }
    for (const [fieldId, value] of entries) {
      uuid(fieldId, 'custom_fields key');
      if (value !== null && typeof value !== 'string') {
        throw new LeadError(
          'bad_request',
          `'custom_fields.${fieldId}' must be a string or null`,
          400
        );
      }
      if (typeof value === 'string' && value.length > 2000) {
        throw new LeadError(
          'bad_request',
          `'custom_fields.${fieldId}' must be 2000 characters or fewer`,
          400
        );
      }
      customFields[fieldId] = typeof value === 'string' ? value.trim() : null;
    }
  }

  return {
    source,
    externalId,
    title,
    contact,
    salesIntent: rawIntent,
    requestedAction,
    assignedToUserId,
    tagIds,
    customFields,
  };
}

function dbFailure(message: string, error?: unknown): never {
  if (error) console.error(`[api/v1/leads] ${message}:`, error);
  throw new LeadError('internal', message, 500);
}

/** Metadata an external connector needs to construct a valid lead payload. */
export async function getLeadIntakeOptions(
  db: SupabaseClient,
  accountId: string
): Promise<LeadIntakeOptions> {
  const { data: settings, error: settingsError } = await db
    .from('lead_intake_settings')
    .select('pipeline_id, stage_id, default_assignee_profile_id, is_enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (settingsError)
    dbFailure('Failed to load lead intake settings', settingsError);

  const [pipelineRes, stageRes, tagsRes, fieldsRes, profilesRes] =
    await Promise.all([
      settings?.pipeline_id
        ? db
            .from('pipelines')
            .select('id, name')
            .eq('id', settings.pipeline_id)
            .eq('account_id', accountId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      settings?.stage_id && settings?.pipeline_id
        ? db
            .from('pipeline_stages')
            .select('id, name')
            .eq('id', settings.stage_id)
            .eq('pipeline_id', settings.pipeline_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      db
        .from('tags')
        .select('id, name, color')
        .eq('account_id', accountId)
        .order('name'),
      db
        .from('custom_fields')
        .select('id, field_name, field_type')
        .eq('account_id', accountId)
        .order('field_name'),
      db
        .from('profiles')
        .select('id, user_id, full_name, email')
        .eq('account_id', accountId)
        .neq('account_role', 'viewer')
        .order('full_name'),
    ]);

  const firstError =
    pipelineRes.error ||
    stageRes.error ||
    tagsRes.error ||
    fieldsRes.error ||
    profilesRes.error;
  if (firstError) dbFailure('Failed to load lead intake options', firstError);

  const profiles = profilesRes.data ?? [];
  const defaultProfile = profiles.find(
    (profile) => profile.id === settings?.default_assignee_profile_id
  );

  return {
    enabled: !!settings?.is_enabled && !!pipelineRes.data && !!stageRes.data,
    pipeline: pipelineRes.data
      ? { id: pipelineRes.data.id, name: pipelineRes.data.name }
      : null,
    initial_stage: stageRes.data
      ? { id: stageRes.data.id, name: stageRes.data.name }
      : null,
    default_salesperson_user_id: defaultProfile?.user_id ?? null,
    tags: (tagsRes.data ?? []).map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
    })),
    custom_fields: (fieldsRes.data ?? []).map((field) => ({
      id: field.id,
      name: field.field_name,
      type: field.field_type,
    })),
    salespeople: profiles.map((profile) => ({
      user_id: profile.user_id,
      name: profile.full_name,
      email: profile.email ?? null,
    })),
  };
}

async function applyContactDetails(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  input: LeadContactInput
): Promise<void> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (input.name !== undefined) update.name = input.name;
  if (input.email !== undefined) update.email = input.email;
  if (input.company !== undefined) update.company = input.company;
  if (Object.keys(update).length === 1) return;

  const { error } = await db
    .from('contacts')
    .update(update)
    .eq('id', contactId)
    .eq('account_id', accountId);
  if (error) dbFailure('Failed to update contact details', error);
}

async function applyCustomFields(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  values: Record<string, string | null>
): Promise<void> {
  const ids = Object.keys(values);
  if (ids.length === 0) return;

  const { data: fields, error: fieldError } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .in('id', ids);
  if (fieldError) dbFailure('Failed to validate custom fields', fieldError);
  const valid = new Set((fields ?? []).map((field) => field.id as string));
  const invalid = ids.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new LeadError(
      'bad_request',
      `Unknown custom field id(s): ${invalid.join(', ')}`,
      400
    );
  }

  const toDelete = ids.filter((id) => values[id] === null || values[id] === '');
  if (toDelete.length > 0) {
    const { error } = await db
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', contactId)
      .in('custom_field_id', toDelete);
    if (error) dbFailure('Failed to clear custom field values', error);
  }

  const rows = ids
    .filter((id) => values[id] !== null && values[id] !== '')
    .map((id) => ({
      contact_id: contactId,
      custom_field_id: id,
      value: values[id],
    }));
  if (rows.length > 0) {
    const { error } = await db.from('contact_custom_values').upsert(rows, {
      onConflict: 'contact_id,custom_field_id',
    });
    if (error) dbFailure('Failed to save custom field values', error);
  }
}

async function addContactTags(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  tagIds: string[]
): Promise<void> {
  if (tagIds.length === 0) return;
  const { data: tags, error: tagError } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .in('id', tagIds);
  if (tagError) dbFailure('Failed to validate tags', tagError);
  const valid = new Set((tags ?? []).map((tag) => tag.id as string));
  const invalid = tagIds.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new LeadError(
      'bad_request',
      `Unknown tag id(s): ${invalid.join(', ')}`,
      400
    );
  }

  const { error } = await db.from('contact_tags').upsert(
    tagIds.map((tagId) => ({ contact_id: contactId, tag_id: tagId })),
    { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
  );
  if (error) dbFailure('Failed to add contact tags', error);
}

async function resolveAssigneeProfileId(
  db: SupabaseClient,
  accountId: string,
  requestedUserId: string | undefined,
  defaultProfileId: string | null
): Promise<string | null> {
  let query = db
    .from('profiles')
    .select('id, account_role')
    .eq('account_id', accountId);

  if (requestedUserId) query = query.eq('user_id', requestedUserId);
  else if (defaultProfileId) query = query.eq('id', defaultProfileId);
  else return null;

  const { data, error } = await query.maybeSingle();
  if (error) dbFailure('Failed to resolve salesperson', error);
  if (!data || data.account_role === 'viewer') {
    throw new LeadError(
      'bad_request',
      'Assigned salesperson must be a non-viewer member of this account',
      400
    );
  }
  return data.id as string;
}

/**
 * Create an external lead, or return the existing deal when the same
 * account/source/id is retried. Existing deals keep their stage, status,
 * and assignee so a delayed retry cannot undo human sales work.
 */
export async function ingestLead(
  db: SupabaseClient,
  accountId: string,
  input: LeadInput
): Promise<IngestedLead> {
  // Resolve an idempotent retry before touching the contact. Besides
  // preserving human edits to qualification data, this prevents a bad
  // retry carrying a different phone from creating an unrelated contact.
  const { data: existing, error: existingError } = await db
    .from('deals')
    .select('*')
    .eq('account_id', accountId)
    .eq('external_source', input.source)
    .eq('external_lead_id', input.externalId)
    .maybeSingle();
  if (existingError)
    dbFailure('Failed to check for an existing lead', existingError);
  if (existing) {
    return {
      created: false,
      contact_id: (existing.contact_id as string | null) ?? null,
      deal: existing as IngestedLead['deal'],
    };
  }

  const { data: settings, error: settingsError } = await db
    .from('lead_intake_settings')
    .select('pipeline_id, stage_id, default_assignee_profile_id, is_enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (settingsError)
    dbFailure('Failed to load lead intake settings', settingsError);
  if (!settings?.is_enabled || !settings.pipeline_id || !settings.stage_id) {
    throw new LeadError(
      'lead_intake_not_configured',
      'External lead intake is not enabled for this account',
      409
    );
  }

  const [{ data: pipeline }, { data: stage }, { data: account }] =
    await Promise.all([
      db
        .from('pipelines')
        .select('id')
        .eq('id', settings.pipeline_id)
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('pipeline_stages')
        .select('id')
        .eq('id', settings.stage_id)
        .eq('pipeline_id', settings.pipeline_id)
        .maybeSingle(),
      db
        .from('accounts')
        .select('default_currency')
        .eq('id', accountId)
        .maybeSingle(),
    ]);
  if (!pipeline || !stage) {
    throw new LeadError(
      'lead_intake_not_configured',
      'The configured intake pipeline or stage is no longer available',
      409
    );
  }

  const auditUserId = await resolveAuditUserId(db, accountId);
  const contactResult = await findOrCreateContact(db, accountId, auditUserId, {
    phone: input.contact.phone,
    name: input.contact.name,
    email: input.contact.email,
    company: input.contact.company,
  });

  await applyContactDetails(db, accountId, contactResult.id, input.contact);
  await applyCustomFields(db, accountId, contactResult.id, input.customFields);
  await addContactTags(db, accountId, contactResult.id, input.tagIds);

  const assignedTo = await resolveAssigneeProfileId(
    db,
    accountId,
    input.assignedToUserId,
    (settings.default_assignee_profile_id as string | null) ?? null
  );

  const { data: created, error: createError } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      pipeline_id: settings.pipeline_id,
      stage_id: settings.stage_id,
      contact_id: contactResult.id,
      assigned_to: assignedTo,
      title: input.title,
      value: 0,
      currency: account?.default_currency ?? 'USD',
      status: 'open',
      external_source: input.source,
      external_lead_id: input.externalId,
      sales_intent: input.salesIntent,
      requested_action: input.requestedAction ?? null,
    })
    .select('*')
    .single();

  if (createError || !created) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('deals')
        .select('*')
        .eq('account_id', accountId)
        .eq('external_source', input.source)
        .eq('external_lead_id', input.externalId)
        .maybeSingle();
      if (raced) {
        return {
          created: false,
          contact_id: contactResult.id,
          deal: raced as IngestedLead['deal'],
        };
      }
    }
    dbFailure('Failed to create lead deal', createError);
  }

  return {
    created: true,
    contact_id: contactResult.id,
    deal: created as IngestedLead['deal'],
  };
}
