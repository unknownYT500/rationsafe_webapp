// src/client/supabase.ts
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey &&
  !supabaseAnonKey.includes('dummy') &&
  !supabaseAnonKey.includes('your_anon_jwt_token_here') &&
  !supabaseUrl.includes('your-project-ref')
);

export function getSupabaseStatus(): { configured: boolean; url: string; mode: 'cloud' | 'local' | 'standby' } {
  if (!isSupabaseConfigured) {
    return { configured: false, url: '', mode: 'standby' };
  }
  const isCloud = supabaseUrl.includes('.supabase.co');
  return {
    configured: true,
    url: supabaseUrl,
    mode: isCloud ? 'cloud' : 'local',
  };
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

/**
 * Subscribes to realtime updates for RationSafe tables.
 * Calls `onUpdate` callback whenever any table changes.
 */
export function subscribeToGrainTrustUpdates(onUpdate: (table: string, payload: any) => void): RealtimeChannel | null {
  if (!isSupabaseConfigured || !supabase) {
    console.info('[Supabase] Standby mode: Set VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY in .env to connect to live Supabase cloud.');
    return null;
  }

  console.info(`[Supabase] Connected to realtime channel: ${supabaseUrl}`);
  const channel = supabase
    .channel('rationsafe_realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, (payload) => onUpdate('cards', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'grain_lots' }, (payload) => onUpdate('grain_lots', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'registrations' }, (payload) => onUpdate('registrations', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'distribution_transactions' }, (payload) => onUpdate('distribution_transactions', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'distribution_nodes' }, (payload) => onUpdate('distribution_nodes', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_events' }, (payload) => onUpdate('audit_events', payload))
    .subscribe();

  return channel;
}
