import { BskyAgent } from '@atproto/api';

async function main() {
  console.log('Starting...');

  const agent = new BskyAgent({ service: 'https://bsky.social' });

  const password = process.env.BSKY_PASSWORD;
  if (!password) {
    console.error('BSKY_PASSWORD not set');
    process.exit(1);
  }

  console.log('Logging in...');
  await agent.login({
    identifier: 'filae.site',
    password,
  });
  console.log('Logged in as:', agent.session?.did);

  // Create a test note on a Bluesky post
  const subjectUri = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l4a5qrmdzz2k';

  console.log('Creating note on:', subjectUri);
  const result = await agent.api.com.atproto.repo.createRecord({
    repo: agent.session!.did,
    collection: 'site.filae.chorus.note',
    record: {
      subject: subjectUri,
      body: 'This is a test community note demonstrating the Chorus bridging-based consensus algorithm. Notes only get certified when raters with diverse perspectives agree.',
      sources: ['https://bsky.social', 'https://github.com/filaebot/chorus'],
      createdAt: new Date().toISOString(),
    },
  });

  console.log('Note created!');
  console.log('URI:', result.data.uri);
  console.log('CID:', result.data.cid);

  // Now index it
  console.log('\nIndexing note...');
  const indexRes = await fetch('https://chorus.filae.workers.dev/api/index/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri: result.data.uri }),
  });

  const indexData = await indexRes.json();
  console.log('Index result:', JSON.stringify(indexData, null, 2));
}

main().catch((e) => {
  console.error('Error:', e.message || e);
  process.exit(1);
});
