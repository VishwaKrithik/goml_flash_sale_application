import { Worker } from 'node:worker_threads';
import http from 'node:http';

const BASE_URL = 'http://localhost:3000';
const CONCURRENT_REQUESTS = 40;

function sendCheckout(userId) {
  return new Promise((resolve) => {
    const req = http.request(
      `${BASE_URL}/naive-checkout`,
      {
        method: 'POST',
        headers: {
          'x-user-id': userId,
          'idempotency-key': `idem-${userId}`,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });
}

async function run() {
  console.log(`Firing ${CONCURRENT_REQUESTS} parallel naive checkouts...`);
  const promises = [];
  for (let i = 1; i <= CONCURRENT_REQUESTS; i++) {
    promises.push(sendCheckout(`test-user-${i}-${Date.now()}`));
  }

  const results = await Promise.all(promises);
  const successes = results.filter((r) => r.status === 200).length;
  const conflicts = results.filter((r) => r.status === 409).length;

  console.log(`\nCompleted: ${successes} succeeded (200 OK), ${conflicts} rejected (409).`);
}

run();