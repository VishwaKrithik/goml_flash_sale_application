import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Track status code counts explicitly
export const status202 = new Counter('status_202_accepted');
export const status409 = new Counter('status_409_conflict');
export const status429 = new Counter('status_429_rate_limited');

export const options = {
  // Fire 50 concurrent virtual users immediately to overwhelm the 20r/s + 40 burst threshold
  scenarios: {
    rate_limit_burst: {
      executor: 'per-vu-iterations',
      vus: 10000,
      iterations: 1, // 50 VUs * 2 iterations = 100 requests in under 1 second
      maxDuration: '10s',
    },
  },
};

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const uniqueId = `k6-user-${vuId}-${iterId}-${Date.now()}`;

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': uniqueId,
      'idempotency-key': `idem-${uniqueId}`,
    },
  };
  const payload = JSON.stringify({});

  const res = http.post('http://localhost:8080/checkout', payload, params);

  if (res.status === 202) {
    status202.add(1);
  } else if (res.status === 409) {
    status409.add(1);
  } else if (res.status === 429) {
    status429.add(1);
  }
//   if (![202, 409, 429].includes(res.status)) {
//     console.log(`Unexpected status: ${res.status} | Body: ${res.body}`);
//   }

  check(res, {
    'is handled response': (r) => [202, 409, 429].includes(r.status),
  });
}