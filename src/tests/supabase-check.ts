// src/tests/supabase-check.ts
/**
 * RationSafe - Supabase Connection & Health Check CLI Tool
 * Run via: npm run test:supabase
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from web directory
dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

console.log('====================================================');
console.log('       RATIONSAFE SUPABASE CONNECTIVITY CHECK       ');
console.log('====================================================\n');

const isPlaceholder = (val: string) =>
  !val ||
  val.includes('your-project-ref') ||
  val.includes('dummy') ||
  val.includes('your_anon') ||
  val.includes('your-anon');

if (isPlaceholder(supabaseUrl) || isPlaceholder(supabaseAnonKey)) {
  console.log('⚠️  SUPABASE NOT CONFIGURED IN web/.env\n');
  console.log('Current settings:');
  console.log(`  VITE_SUPABASE_URL:      ${supabaseUrl || '(not set)'}`);
  console.log(`  VITE_SUPABASE_ANON_KEY: ${supabaseAnonKey ? `${supabaseAnonKey.substring(0, 15)}...` : '(not set)'}\n`);
  console.log('👉 To connect RationSafe to your Supabase project:');
  console.log('   1. Create a project at https://supabase.com');
  console.log('   2. Go to Project Settings -> API');
  console.log('   3. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in web/.env');
  console.log('   4. Run migrations from web/supabase/migrations/ in Supabase SQL Editor');
  console.log('   5. Re-run: npm run test:supabase\n');
  process.exit(0);
}

async function verifyConnection() {
  console.log(`📡 Connecting to Supabase endpoint: ${supabaseUrl}`);
  const keyToUse = serviceRoleKey && !isPlaceholder(serviceRoleKey) ? serviceRoleKey : supabaseAnonKey;
  const client = createClient(supabaseUrl, keyToUse);

  try {
    // 1. Check distribution_nodes table
    const { data: nodes, error: nodeError } = await client
      .from('distribution_nodes')
      .select('id, name, status')
      .limit(5);

    if (nodeError) {
      console.error('❌ Error querying distribution_nodes:', nodeError.message);
      if (nodeError.code === '42P01' || nodeError.message.includes('schema cache') || nodeError.message.includes('Could not find')) {
        console.log('\n💡 Tables not yet created in Supabase!');
        console.log('   To create them:');
        console.log('   1. In Supabase Dashboard, open SQL Editor -> New query');
        console.log('   2. Paste and run: web/supabase/migrations/20261014000000_graintrust_schema.sql');
        console.log('   3. Paste and run: web/supabase/seed.sql');
        console.log('   4. Re-run: npm run test:supabase\n');
      }
      process.exit(1);
    }

    console.log(`✅ [OK] distribution_nodes table accessible (${nodes?.length ?? 0} depots found)`);

    // 2. Check grain_lots table
    const { data: lots, error: lotsError } = await client
      .from('grain_lots')
      .select('id, name, remaining_quantity')
      .limit(5);

    if (lotsError) {
      console.error('❌ Error querying grain_lots:', lotsError.message);
      process.exit(1);
    }

    console.log(`✅ [OK] grain_lots table accessible (${lots?.length ?? 0} lots found)`);

    // 3. Check cards table
    const { data: cards, error: cardsError } = await client
      .from('cards')
      .select('id, status')
      .limit(5);

    if (cardsError) {
      console.error('❌ Error querying cards:', cardsError.message);
      process.exit(1);
    }

    console.log(`✅ [OK] cards table accessible (${cards?.length ?? 0} ration cards registered)`);

    console.log('\n====================================================');
    console.log('🎉 SUPABASE CONNECTION SUCCESSFUL & READY FOR SYNC! ');
    console.log('====================================================\n');
  } catch (err: any) {
    console.error('❌ Unexpected connectivity error:', err.message || err);
    process.exit(1);
  }
}

verifyConnection();
