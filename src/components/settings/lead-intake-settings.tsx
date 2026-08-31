'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Route, UserRoundCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import type { Pipeline, PipelineStage, Profile } from '@/types';

interface LeadIntakeSettingsRow {
  pipeline_id: string | null;
  stage_id: string | null;
  default_assignee_profile_id: string | null;
  is_enabled: boolean;
}

const EMPTY: LeadIntakeSettingsRow = {
  pipeline_id: null,
  stage_id: null,
  default_assignee_profile_id: null,
  is_enabled: false,
};

export function LeadIntakeSettings() {
  const t = useTranslations('Settings.deals.leadIntake');
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [saved, setSaved] = useState<LeadIntakeSettingsRow>(EMPTY);
  const [draft, setDraft] = useState<LeadIntakeSettingsRow>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [pipelinesRes, stagesRes, profilesRes, settingsRes] =
      await Promise.all([
        supabase.from('pipelines').select('*').order('created_at'),
        supabase.from('pipeline_stages').select('*').order('position'),
        supabase
          .from('profiles')
          .select('*')
          .neq('account_role', 'viewer')
          .order('full_name'),
        supabase
          .from('lead_intake_settings')
          .select(
            'pipeline_id, stage_id, default_assignee_profile_id, is_enabled'
          )
          .eq('account_id', accountId)
          .maybeSingle(),
      ]);

    const firstError =
      pipelinesRes.error ||
      stagesRes.error ||
      profilesRes.error ||
      settingsRes.error;
    if (firstError) {
      console.error('[LeadIntakeSettings] load error:', firstError);
      toast.error(t('loadFailed'));
      setLoading(false);
      return;
    }

    setPipelines((pipelinesRes.data ?? []) as Pipeline[]);
    setStages((stagesRes.data ?? []) as PipelineStage[]);
    setProfiles((profilesRes.data ?? []) as Profile[]);
    const row = (settingsRes.data as LeadIntakeSettingsRow | null) ?? EMPTY;
    setSaved(row);
    setDraft(row);
    setLoading(false);
  }, [accountId, supabase, t]);

  useEffect(() => {
    // `load` owns the async Supabase round-trip; its state updates after
    // the awaited queries, matching the other settings panels.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const availableStages = useMemo(
    () => stages.filter((stage) => stage.pipeline_id === draft.pipeline_id),
    [draft.pipeline_id, stages]
  );
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const canEnable = !!draft.pipeline_id && !!draft.stage_id;

  function setPipeline(pipelineId: string) {
    const nextStages = stages.filter(
      (stage) => stage.pipeline_id === pipelineId
    );
    setDraft((current) => ({
      ...current,
      pipeline_id: pipelineId || null,
      stage_id: nextStages[0]?.id ?? null,
      is_enabled:
        pipelineId && nextStages.length > 0 ? current.is_enabled : false,
    }));
  }

  async function save() {
    if (!accountId || !canEditSettings) return;
    if (draft.is_enabled && !canEnable) {
      toast.error(t('pipelineRequired'));
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('lead_intake_settings').upsert(
      {
        account_id: accountId,
        pipeline_id: draft.pipeline_id,
        stage_id: draft.stage_id,
        default_assignee_profile_id: draft.default_assignee_profile_id,
        is_enabled: draft.is_enabled,
      },
      { onConflict: 'account_id' }
    );
    setSaving(false);
    if (error) {
      console.error('[LeadIntakeSettings] save error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setSaved(draft);
    toast.success(t('saveSuccess'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Route className="text-primary size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : pipelines.length === 0 ? (
          <div className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            <p>{t('noPipeline')}</p>
            <Link
              href="/pipelines"
              className="border-border bg-background text-foreground hover:bg-muted mt-3 inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium transition-colors"
            >
              {t('createPipeline')}
            </Link>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t('pipeline')}</Label>
                <select
                  value={draft.pipeline_id ?? ''}
                  onChange={(event) => setPipeline(event.target.value)}
                  disabled={!canEditSettings || profileLoading}
                  className="border-border bg-muted text-foreground h-9 rounded-lg border px-2.5 text-sm disabled:opacity-60"
                >
                  <option value="">{t('selectPipeline')}</option>
                  {pipelines.map((pipeline) => (
                    <option key={pipeline.id} value={pipeline.id}>
                      {pipeline.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label>{t('initialStage')}</Label>
                <select
                  value={draft.stage_id ?? ''}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      stage_id: event.target.value || null,
                    }))
                  }
                  disabled={
                    !canEditSettings || !draft.pipeline_id || profileLoading
                  }
                  className="border-border bg-muted text-foreground h-9 rounded-lg border px-2.5 text-sm disabled:opacity-60"
                >
                  <option value="">{t('selectStage')}</option>
                  {availableStages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2 sm:max-w-sm">
              <Label className="flex items-center gap-2">
                <UserRoundCheck className="text-muted-foreground size-4" />
                {t('defaultSalesperson')}
              </Label>
              <select
                value={draft.default_assignee_profile_id ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    default_assignee_profile_id: event.target.value || null,
                  }))
                }
                disabled={!canEditSettings || profileLoading}
                className="border-border bg-muted text-foreground h-9 rounded-lg border px-2.5 text-sm disabled:opacity-60"
              >
                <option value="">{t('unassigned')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.full_name || profile.email}
                  </option>
                ))}
              </select>
            </div>

            <label className="border-border bg-muted/40 flex items-start gap-3 rounded-lg border p-3">
              <Checkbox
                checked={draft.is_enabled}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    is_enabled: checked === true,
                  }))
                }
                disabled={!canEditSettings || !canEnable || profileLoading}
              />
              <span>
                <span className="text-foreground block text-sm font-medium">
                  {t('enable')}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {t('enableDesc')}
                </span>
              </span>
            </label>

            {!canEditSettings && (
              <p className="text-muted-foreground text-xs">
                {t('adminOnlyHint')}
              </p>
            )}

            {canEditSettings && (
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {saving ? t('saving') : t('save')}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
