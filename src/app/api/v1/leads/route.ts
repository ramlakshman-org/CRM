// ============================================================
// POST /api/v1/leads — retry-safe external lead intake.
// Scope: leads:write
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ingestLead, LeadError, parseLeadInput } from '@/lib/api/v1/leads';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'leads:write');
    const body = await request.json().catch(() => null);
    const input = parseLeadInput(body);
    const result = await ingestLead(ctx.supabase, ctx.accountId, input);
    return ok(result, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof LeadError) {
      return fail(error.code, error.message, error.status);
    }
    return toApiErrorResponse(error);
  }
}
