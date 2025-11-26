import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NG_APP_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NG_APP_SUPABASE_ANON_KEY;
const ownerId = process.env.SUPABASE_SEED_USER_ID;

if (!supabaseUrl || !supabaseKey || !ownerId) {
  console.error('Missing NG_APP_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/NG_APP_SUPABASE_ANON_KEY, or SUPABASE_SEED_USER_ID');
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Running seed with anon key; make sure RLS allows this owner_id for the provided key/session.');
}

const client = createClient(supabaseUrl, supabaseKey);
const now = new Date().toISOString();

const seedProject = {
  id: 'proj-seed-1',
  owner_id: ownerId,
  title: 'Alpha Protocol',
  description: 'NanoFlow core engine boot plan.',
  created_date: now,
  data: {
    tasks: [
      {
        id: 't1',
        title: 'Stage 1: Environment setup',
        content: 'Bootstrap project environment.\n- [ ] Init git repo\n- [ ] Install Node.js deps',
        stage: 1,
        parentId: null,
        order: 1,
        rank: 10000,
        status: 'active',
        x: 100,
        y: 100,
        createdDate: now,
        displayId: '1'
      },
      {
        id: 't2',
        title: 'Core logic implementation',
        content: 'Deliver core business logic.\n- [ ] Write unit tests',
        stage: 2,
        parentId: 't1',
        order: 1,
        rank: 10500,
        status: 'active',
        x: 300,
        y: 100,
        createdDate: now,
        displayId: '1,a'
      }
    ],
    connections: [{ source: 't1', target: 't2' }]
  }
};

const { error } = await client.from('projects').upsert(seedProject);

if (error) {
  console.error('Seed insert failed', error);
  process.exit(1);
}

console.log('Seed project inserted for owner_id', ownerId);
