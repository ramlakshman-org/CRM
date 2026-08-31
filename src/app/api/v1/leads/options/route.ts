// ============================================================
// GET /api/v1/leads/options — account-approved ids and intake target.
// Scope: leads:write
// ============================================================

import { getLeadIntakeOptions, LeadError } from '@/lib/api/v1/leads';
import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'leads:write');
    return ok(await getLeadIntakeOptions(ctx.supabase, ctx.accountId));
  } catch (error) {
    if (error instanceof LeadError) {
      return fail(error.code, error.message, error.status);
    }
    return toApiErrorResponse(error);
  }
}
