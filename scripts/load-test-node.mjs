import http from 'node:http';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:8080/checkout';
const TOTAL_REQUESTS = 10000;
const CONCURRENCY = 100;

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: CONCURRENCY,
});

let completed = 0;
let status202 = 0;
let status409 = 0;
let statusOther = 0;

function sendRequest(index) {
  return new Promise((resolve) => {
    const userId = `node-user-${index}-${Date.now()}`;
    const req = http.request(
      TARGET_URL,
      {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'idempotency-key': `idem-${userId}`,
        },
      },
      (res) => {
        if (res.statusCode === 202) status202++;
        else if (res.statusCode === 409) status409++;
        else statusOther++;

        res.resume();
        res.on('end', () => {
          completed++;
          if (completed % 1000 === 0) {
            process.stdout.write(`Completed ${completed}/${TOTAL_REQUESTS} requests...\r`);
          }
          resolve();
        });
      }
    );

    req.on('error', () => {
      statusOther++;
      completed++;
      resolve();
    });

    req.write(JSON.stringify({}));
    req.end();
  });
}

async function run() {
  console.log(`Starting Node concurrency test: ${TOTAL_REQUESTS} requests (${CONCURRENCY} concurrent workers)...`);
  const startTime = Date.now();

  let pointer = 0;
  async function worker() {
    while (pointer < TOTAL_REQUESTS) {
      const idx = pointer++;
      await sendRequest(idx);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n--- Test Complete in ${durationSec}s ---`);
  console.log(`202 Accepted (Purchased): ${status202}`);
  console.log(`409 Conflict (Sold Out):  ${status409}`);
  console.log(`Other Status Codes:       ${statusOther}`);
  console.log(`Throughput:               ${(TOTAL_REQUESTS / durationSec).toFixed(0)} req/s`);
}

run();